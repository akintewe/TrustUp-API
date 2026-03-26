import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { LiquidityService } from './liquidity.service';
import { InvestmentSummaryResponseDto } from './dto/investment-summary-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('liquidity')
@Controller('liquidity')
export class LiquidityController {
  constructor(private readonly liquidityService: LiquidityService) {}

  @Get('my-summary')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get personal investment summary',
    description:
      'Returns a comprehensive summary of the authenticated user\'s liquidity pool investment, including share balance, current value, earnings, APY, pool size, and active loan count. Data is cached in Redis with a 1-minute TTL. Users with no investment receive a valid zero-value response.',
  })
  @ApiResponse({
    status: 200,
    description: 'Investment summary retrieved successfully',
    schema: {
      example: {
        success: true,
        data: {
          totalInvested: 1000.0,
          currentValue: 1085.5,
          earnings: 85.5,
          earningsPercent: 8.55,
          apy: 9.2,
          poolSize: 2500000.0,
          activeLoans: 142,
          shares: 950.1234567,
        },
        message: 'Investment summary retrieved successfully',
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Unauthorized — missing or invalid JWT' })
  @ApiResponse({ status: 503, description: 'Liquidity contract temporarily unavailable' })
  async getMyInvestmentSummary(
    @CurrentUser() user: { wallet: string },
  ): Promise<{ success: boolean; data: InvestmentSummaryResponseDto; message: string }> {
    const data = await this.liquidityService.getInvestmentSummary(user.wallet);
    return { success: true, data, message: 'Investment summary retrieved successfully' };
  }
}
