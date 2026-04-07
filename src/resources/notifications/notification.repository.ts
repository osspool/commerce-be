import { Repository } from '@classytic/mongokit';
import InAppNotification from './notification.model.js';
import type { IInAppNotification } from './notification.model.js';

interface ListOptions {
  page?: number;
  limit?: number;
  unreadOnly?: boolean;
  type?: string;
}

class NotificationRepository extends Repository<IInAppNotification> {
  constructor() {
    super(InAppNotification, [], {
      defaultLimit: 20,
      maxLimit: 50,
    });
  }

  async listForUser(orgId: string, userId: string, options: ListOptions = {}) {
    const { page = 1, limit = 20, unreadOnly = false, type } = options;
    const filter: Record<string, unknown> = { organizationId: orgId, userId };

    if (unreadOnly) filter.read = false;
    if (type) filter.type = type;

    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      InAppNotification.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      InAppNotification.countDocuments(filter),
    ]);

    return {
      data,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async countUnread(orgId: string, userId: string): Promise<number> {
    return InAppNotification.countDocuments({
      organizationId: orgId,
      userId,
      read: false,
    });
  }

  async markRead(orgId: string, userId: string, id: string): Promise<IInAppNotification | null> {
    return InAppNotification.findOneAndUpdate(
      { _id: id, organizationId: orgId, userId, read: false },
      { $set: { read: true, readAt: new Date() } },
      { returnDocument: 'after' },
    ).lean();
  }

  async markAllRead(orgId: string, userId: string): Promise<number> {
    const result = await InAppNotification.updateMany(
      { organizationId: orgId, userId, read: false },
      { $set: { read: true, readAt: new Date() } },
    );
    return result.modifiedCount;
  }

  async bulkCreate(notifications: Partial<IInAppNotification>[]): Promise<void> {
    if (notifications.length === 0) return;
    await InAppNotification.insertMany(notifications, { ordered: false });
  }
}

export default new NotificationRepository();
