import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { SubmitTransactionRequestDto } from './dto/submit-transaction-request.dto';
import { SubmitTransactionResponseDto } from './dto/submit-transaction-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly transactionsService: TransactionsService) {}

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Submit a signed XDR transaction to the Stellar network',
    description:
      'Validates the XDR format, submits the signed transaction to the Stellar network via Horizon API, stores the transaction hash with pending status in the database, and returns the hash immediately without waiting for confirmation.',
  })
  @ApiResponse({
    status: 200,
    description: 'Transaction submitted successfully — hash returned with pending status',
    type: SubmitTransactionResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Malformed XDR, invalid signature, or Stellar rejection' })
  @ApiResponse({ status: 401, description: 'Unauthorized - missing or invalid JWT' })
  @ApiResponse({ status: 503, description: 'Stellar network temporarily unavailable' })
  async submitTransaction(
    @CurrentUser() user: { wallet: string },
    @Body() dto: SubmitTransactionRequestDto,
  ): Promise<{ success: boolean; data: SubmitTransactionResponseDto; message: string }> {
    const data = await this.transactionsService.submitTransaction(user.wallet, dto);
    return {
      success: true,
      data,
      message: 'Transaction submitted successfully',
    };
  }
}
