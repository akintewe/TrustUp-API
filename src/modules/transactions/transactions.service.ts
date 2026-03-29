import {
  Injectable,
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as StellarSdk from 'stellar-sdk';
import { SupabaseService } from '../../database/supabase.client';
import { SubmitTransactionRequestDto, TransactionType } from './dto/submit-transaction-request.dto';
import { SubmitTransactionResponseDto } from './dto/submit-transaction-response.dto';

const HORIZON_ERROR_MAP: Record<string, string> = {
  op_bad_auth: 'Invalid transaction signature. Please re-sign and try again.',
  op_no_source_account: 'Source account not found on the Stellar network.',
  tx_bad_seq: 'Transaction sequence number is outdated. Please rebuild the transaction.',
  tx_insufficient_balance: 'Insufficient balance to cover this transaction.',
  tx_bad_auth: 'Invalid transaction signature. Please re-sign and try again.',
  tx_failed: 'Transaction failed on the Stellar network.',
  tx_too_late: 'Transaction expired before it could be submitted.',
  tx_too_early: 'Transaction time bounds not yet valid.',
  tx_insufficient_fee: 'Transaction fee is too low to be accepted by the network.',
  tx_no_account: 'Source account does not exist on the Stellar network.',
};

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);
  private readonly horizonServer: StellarSdk.Horizon.Server;
  private readonly networkPassphrase: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
  ) {
    const horizonUrl =
      this.configService.get<string>('STELLAR_HORIZON_URL') ||
      'https://horizon-testnet.stellar.org';

    this.networkPassphrase =
      this.configService.get<string>('STELLAR_NETWORK_PASSPHRASE') ||
      StellarSdk.Networks.TESTNET;

    this.horizonServer = new StellarSdk.Horizon.Server(horizonUrl);
    this.logger.log(`Horizon client initialized: ${horizonUrl}`);
  }

  async submitTransaction(
    wallet: string,
    dto: SubmitTransactionRequestDto,
  ): Promise<SubmitTransactionResponseDto> {
    const transaction = this.parseXdr(dto.xdr);

    let transactionHash: string;
    try {
      const horizonResult = await this.horizonServer.submitTransaction(transaction);
      transactionHash = horizonResult.hash;
    } catch (error) {
      this.handleHorizonError(error);
    }

    this.persistTransactionRecord(wallet, transactionHash, dto.type).catch((err) => {
      this.logger.error(
        `Failed to persist transaction record for hash ${transactionHash}: ${err.message}`,
      );
    });

    this.logger.log(
      `Transaction submitted — hash: ${transactionHash}, type: ${dto.type}, wallet: ${wallet.slice(0, 8)}...`,
    );

    return { transactionHash, status: 'pending' };
  }

  private parseXdr(xdr: string): StellarSdk.Transaction | StellarSdk.FeeBumpTransaction {
    try {
      return StellarSdk.TransactionBuilder.fromXDR(xdr, this.networkPassphrase);
    } catch {
      throw new BadRequestException({
        code: 'TRANSACTION_INVALID_XDR',
        message: 'The provided XDR string is malformed or invalid.',
      });
    }
  }

  private handleHorizonError(error: unknown): never {
    const err = error as {
      response?: { data?: { extras?: { result_codes?: { transaction?: string; operations?: string[] } } } };
      message?: string;
    };

    const resultCodes = err?.response?.data?.extras?.result_codes;

    if (resultCodes) {
      const txCode = resultCodes.transaction;
      const opCodes = resultCodes.operations ?? [];
      const allCodes = [txCode, ...opCodes].filter(Boolean);

      for (const code of allCodes) {
        if (code && HORIZON_ERROR_MAP[code]) {
          throw new BadRequestException({
            code: `STELLAR_${code.toUpperCase()}`,
            message: HORIZON_ERROR_MAP[code],
          });
        }
      }

      throw new BadRequestException({
        code: 'STELLAR_TRANSACTION_FAILED',
        message: `Transaction rejected by the Stellar network: ${allCodes.join(', ')}`,
      });
    }

    const message = err?.message ?? 'Unknown error';
    if (message.toLowerCase().includes('timeout') || message.toLowerCase().includes('network')) {
      throw new ServiceUnavailableException({
        code: 'STELLAR_NETWORK_UNAVAILABLE',
        message: 'Stellar network is temporarily unavailable. Please try again later.',
      });
    }

    this.logger.error(`Horizon submission error: ${message}`);
    throw new InternalServerErrorException({
      code: 'STELLAR_SUBMISSION_FAILED',
      message: 'Failed to submit transaction to the Stellar network. Please try again.',
    });
  }

  private async persistTransactionRecord(
    wallet: string,
    hash: string,
    type: TransactionType,
  ): Promise<void> {
    const client = this.supabaseService.getServiceRoleClient();
    const { error } = await client.from('transactions').insert({
      user_wallet: wallet,
      transaction_hash: hash,
      type,
      status: 'pending',
      submitted_at: new Date().toISOString(),
    });

    if (error) {
      throw new Error(error.message ?? 'Supabase insert failed');
    }
  }
}
