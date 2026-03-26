import {
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
  ConflictException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { Keypair, StrKey } from 'stellar-sdk';
import { SupabaseService } from '../../database/supabase.client';
import { UsersRepository } from '../../database/repositories/users.repository';
import { NonceResponseDto } from './dto/nonce-response.dto';
import { VerifyRequestDto } from './dto/verify-request.dto';
import { AuthResponseDto } from './dto/auth-response.dto';
import { RegisterRequestDto } from './dto/register-request.dto';
import {
  ACCESS_TOKEN_EXPIRATION,
  ACCESS_TOKEN_EXPIRATION_SECONDS,
  REFRESH_TOKEN_EXPIRATION,
  REFRESH_TOKEN_EXPIRATION_MS,
} from '../../config/jwt.config';

/** Nonce expiration time in seconds (5 minutes) */
const NONCE_EXPIRATION_SECONDS = 300;

@Injectable()
export class AuthService {
  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly usersRepository: UsersRepository,
  ) {}

  /**
   * Registers a new user with comprehensive profile information.
   * Handles duplicate checking, optional image upload, user creation, and issues JWT tokens.
   */
  async register(dto: RegisterRequestDto, profileImage?: any): Promise<any> {
    // 1. Check if wallet address already exists
    const existingWallet = await this.usersRepository.findByWallet(dto.walletAddress);
    if (existingWallet) {
      throw new ConflictException({
        code: 'AUTH_WALLET_EXISTS',
        message: 'Wallet address is already registered.',
      });
    }

    // 2. Check if username is already taken
    const usernameTaken = await this.usersRepository.checkUsernameExists(dto.username);
    if (usernameTaken) {
      throw new ConflictException({
        code: 'AUTH_USERNAME_TAKEN',
        message: 'Username is already taken.',
      });
    }

    // 3. Handle optional profile image upload to Supabase Storage
    let avatarUrl: string | null = null;
    if (profileImage) {
      avatarUrl = await this.usersRepository.uploadAvatar(dto.walletAddress, profileImage);
    }

    // 4. Create the new user record in the database
    const user = await this.usersRepository.createProfile({
      wallet: dto.walletAddress,
      username: dto.username,
      displayName: dto.displayName,
      avatarUrl,
    });

    // 5. Generate and return JWT tokens (this seamlessly re-uses existing session logic)
    const tokens = await this.generateTokens(dto.walletAddress);

    return {
      user: {
        id: user.id,
        walletAddress: user.wallet_address,
        username: user.username,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        createdAt: user.created_at,
      },
      ...tokens,
    };
  }

  /**
   * Generates a cryptographically secure nonce for wallet signature authentication.
   * Stores the nonce in the database with a 5-minute expiration.
   *
   * @param wallet - Stellar wallet address (validated by DTO)
   * @returns Nonce and expiration timestamp
   */
  async generateNonce(wallet: string): Promise<NonceResponseDto> {
    const nonce = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + NONCE_EXPIRATION_SECONDS * 1000);

    const client = this.supabaseService.getServiceRoleClient();

    const { error } = await client.from('nonces').insert({
      wallet_address: wallet,
      nonce,
      expires_at: expiresAt.toISOString(),
    });

    if (error) {
      throw new InternalServerErrorException({
        code: 'DATABASE_NONCE_INSERT_FAILED',
        message: 'Failed to generate nonce. Please try again.',
      });
    }

    return {
      nonce,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Verifies a Stellar wallet signature against a previously issued nonce.
   * Validates that the nonce exists, has not expired, has not been used, and
   * that the Ed25519 signature was produced by the wallet's private key.
   * Marks the nonce as used on success to prevent replay attacks.
   *
   * Throws UnauthorizedException on any validation or signature failure.
   * Returns void — call generateTokens(wallet) afterwards to issue JWT tokens.
   *
   * @param dto - Wallet address, nonce, and base64-encoded signature
   */
  async verifySignature(dto: VerifyRequestDto): Promise<void> {
    const client = this.supabaseService.getServiceRoleClient();

    // 1. Fetch nonce — must exist, not yet used, and belong to this wallet
    const { data: nonceRecord, error: nonceError } = await client
      .from('nonces')
      .select('id, expires_at')
      .eq('wallet_address', dto.wallet)
      .eq('nonce', dto.nonce)
      .is('used_at', null)
      .single();

    if (nonceError || !nonceRecord) {
      throw new UnauthorizedException({
        code: 'AUTH_NONCE_NOT_FOUND',
        message: 'Nonce not found or already used. Please request a new nonce.',
      });
    }

    // 2. Check nonce expiration
    if (new Date(nonceRecord.expires_at) < new Date()) {
      throw new UnauthorizedException({
        code: 'AUTH_NONCE_EXPIRED',
        message: 'Nonce has expired. Please request a new nonce.',
      });
    }

    // 3. Verify Ed25519 signature using Stellar SDK
    // StrKey validates the public key format before passing to Keypair
    if (!StrKey.isValidEd25519PublicKey(dto.wallet)) {
      throw new UnauthorizedException({
        code: 'AUTH_SIGNATURE_INVALID',
        message: 'Invalid signature. Verification failed.',
      });
    }

    try {
      const keypair = Keypair.fromPublicKey(dto.wallet);
      const isValid = keypair.verify(
        Buffer.from(dto.nonce),
        Buffer.from(dto.signature, 'base64'),
      );

      if (!isValid) {
        throw new UnauthorizedException({
          code: 'AUTH_SIGNATURE_INVALID',
          message: 'Invalid signature. Verification failed.',
        });
      }
    } catch (err) {
      if (err instanceof UnauthorizedException) throw err;
      throw new UnauthorizedException({
        code: 'AUTH_SIGNATURE_INVALID',
        message: 'Invalid signature. Verification failed.',
      });
    }

    // 4. Mark nonce as used to prevent replay attacks
    await client
      .from('nonces')
      .update({ used_at: new Date().toISOString() })
      .eq('id', nonceRecord.id);
  }

  /**
   * Upserts the user record for the given wallet (creates on first login, updates
   * last_seen_at on subsequent logins) and returns the internal user ID.
   * Throws UnauthorizedException if the account is blocked.
   *
   * @param wallet - Stellar wallet address
   * @returns Internal user UUID
   */
  private async findOrCreateUser(wallet: string): Promise<string> {
    const client = this.supabaseService.getServiceRoleClient();

    const { data: user, error } = await client
      .from('users')
      .upsert(
        {
          wallet_address: wallet,
          last_seen_at: new Date().toISOString(),
        },
        { onConflict: 'wallet_address' },
      )
      .select('id, status')
      .single();

    if (error || !user) {
      throw new InternalServerErrorException({
        code: 'DATABASE_USER_UPSERT_FAILED',
        message: 'Failed to create or update user record.',
      });
    }

    if (user.status === 'blocked') {
      throw new UnauthorizedException({
        code: 'AUTH_USER_BLOCKED',
        message: 'This account has been suspended.',
      });
    }

    return user.id;
  }

  /**
   * Generates a signed JWT access token and refresh token for the given wallet,
   * hashes the refresh token with SHA-256, and persists the session in the database.
   *
   * Access token payload:  `{ wallet, type: 'access', iat, exp }`
   * Refresh token payload: `{ wallet, type: 'refresh', iat, exp }`
   * Refresh token hash: SHA-256 hex digest (per sessions table schema)
   *
   * Call verifySignature(dto) before this method to authenticate the wallet.
   *
   * @param wallet - Stellar wallet address (identity claim in JWT payload)
   * @returns Signed access token, refresh token, expiration, and token type
   */
  async generateTokens(wallet: string): Promise<AuthResponseDto> {
    const userId = await this.findOrCreateUser(wallet);
    const client = this.supabaseService.getServiceRoleClient();

    const accessToken = this.jwtService.sign(
      { wallet, type: 'access' },
      {
        secret: this.configService.get<string>('JWT_SECRET'),
        expiresIn: ACCESS_TOKEN_EXPIRATION,
      },
    );

    const refreshToken = this.jwtService.sign(
      { wallet, type: 'refresh' },
      {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: REFRESH_TOKEN_EXPIRATION,
      },
    );

    // Hash refresh token with SHA-256 before storage (per sessions table schema)
    const refreshTokenHash = createHash('sha256').update(refreshToken).digest('hex');
    const refreshExpiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRATION_MS);

    const { error: sessionError } = await client.from('sessions').insert({
      user_id: userId,
      refresh_token_hash: refreshTokenHash,
      expires_at: refreshExpiresAt.toISOString(),
    });

    if (sessionError) {
      throw new InternalServerErrorException({
        code: 'DATABASE_SESSION_CREATE_FAILED',
        message: 'Failed to create session.',
      });
    }

    return {
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_EXPIRATION_SECONDS,
      tokenType: 'Bearer',
    };
  } 
}
