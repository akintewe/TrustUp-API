import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { NotificationListQueryDto } from './dto/notification-list-query.dto';
import { NotificationListResponseDto } from './dto/notification-list-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get notifications for authenticated user',
    description:
      'Returns paginated notifications for the authenticated user ordered by creation date (newest first). Supports filtering by read/unread status. Always includes the total unread count for badge display.',
  })
  @ApiQuery({ name: 'unread', required: false, type: Boolean, description: 'Filter by unread only' })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Page size (default 20, max 100)' })
  @ApiQuery({ name: 'offset', required: false, type: Number, description: 'Number of records to skip (default 0)' })
  @ApiResponse({
    status: 200,
    description: 'Notifications retrieved successfully',
    type: NotificationListResponseDto,
  })
  @ApiResponse({ status: 401, description: 'Unauthorized - missing or invalid JWT' })
  async getNotifications(
    @CurrentUser() user: { wallet: string },
    @Query() query: NotificationListQueryDto,
  ) {
    const data = await this.notificationsService.getNotifications(user.wallet, query);
    return { success: true, ...data };
  }
}
