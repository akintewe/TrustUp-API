import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../../database/supabase.client';
import { NotificationListQueryDto } from './dto/notification-list-query.dto';
import {
  NotificationItemDto,
  NotificationListResponseDto,
} from './dto/notification-list-response.dto';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async getNotifications(
    wallet: string,
    query: NotificationListQueryDto,
  ): Promise<NotificationListResponseDto> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    const client = this.supabaseService.getServiceRoleClient();

    let notificationsQuery = client
      .from('notifications')
      .select('id, type, title, message, data, is_read, created_at, read_at', { count: 'exact' })
      .eq('user_wallet', wallet)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (query.unread === true) {
      notificationsQuery = notificationsQuery.eq('is_read', false);
    }

    const { data: notifications, error, count } = await notificationsQuery;

    if (error) {
      this.logger.error(`Failed to fetch notifications for ${wallet}: ${error.message}`);
      throw new Error(error.message);
    }

    const { count: unreadCount, error: unreadError } = await client
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_wallet', wallet)
      .eq('is_read', false);

    if (unreadError) {
      this.logger.error(`Failed to fetch unread count for ${wallet}: ${unreadError.message}`);
      throw new Error(unreadError.message);
    }

    const data: NotificationItemDto[] = (notifications ?? []).map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      message: n.message,
      data: n.data ?? {},
      isRead: n.is_read,
      createdAt: n.created_at,
      readAt: n.read_at ?? null,
    }));

    return {
      data,
      pagination: {
        limit,
        offset,
        total: count ?? 0,
      },
      unreadCount: unreadCount ?? 0,
    };
  }
}
