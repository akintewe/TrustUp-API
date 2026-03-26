import {
  Controller,
  Post,
  Body,
  Param,
  ParseUUIDPipe,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { LoansService } from './loans.service';
import { LoanQuoteRequestDto } from './dto/loan-quote-request.dto';
import { LoanQuoteResponseDto } from './dto/loan-quote-response.dto';
import { LoanPaymentRequestDto } from './dto/loan-payment-request.dto';
import { LoanPaymentResponseDto } from './dto/loan-payment-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('loans')
@Controller('loans')
export class LoansController {
  constructor(private readonly loansService: LoansService) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Calculate loan quote',
    description:
      'Calculates loan terms (interest rate, repayment schedule, total cost) based on user reputation without creating an actual loan on-chain. Requires JWT authentication.',
  })
  @ApiResponse({
    status: 200,
    description: 'Loan quote calculated successfully',
    type: LoanQuoteResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid input or amount exceeds credit limit' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 404, description: 'Merchant not found' })
  async getLoanQuote(
    @CurrentUser() user: { wallet: string },
    @Body() dto: LoanQuoteRequestDto,
  ) {
    const data = await this.loansService.calculateLoanQuote(user.wallet, dto);
    return { success: true, data, message: 'Loan quote calculated successfully' };
  }

  @Post(':loanId/pay')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiParam({
    name: 'loanId',
    description: 'UUID of the loan to repay',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @ApiOperation({
    summary: 'Make a loan repayment',
    description:
      'Validates the payment, constructs an unsigned Soroban repay_loan() transaction, and returns it alongside a payment preview. The mobile app must sign the XDR and submit the signed transaction back to the network. Requires JWT authentication.',
  })
  @ApiResponse({
    status: 200,
    description: 'Unsigned XDR transaction and payment preview returned successfully',
    type: LoanPaymentResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Invalid payment amount or loan not active' })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 404, description: 'Loan not found or does not belong to authenticated user' })
  @ApiResponse({ status: 503, description: 'Blockchain contract unavailable' })
  async repayLoan(
    @CurrentUser() user: { wallet: string },
    @Param('loanId', ParseUUIDPipe) loanId: string,
    @Body() dto: LoanPaymentRequestDto,
  ) {
    const data = await this.loansService.repayLoan(user.wallet, loanId, dto);
    return { success: true, data, message: 'Repayment transaction constructed successfully' };
  }
}

