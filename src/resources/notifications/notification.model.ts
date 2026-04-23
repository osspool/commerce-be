import mongoose, { type HydratedDocument, Schema } from 'mongoose';

// ============================================
// INTERFACE
// ============================================

export interface INotificationData {
  link?: string;
  entityId?: string;
  entityType?: string;
  meta?: Record<string, unknown>;
}

export interface IInAppNotification {
  organizationId: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  data?: INotificationData;
  read: boolean;
  readAt: Date | null;
  priority: 'low' | 'normal' | 'high';
  createdAt: Date;
  updatedAt: Date;
}

export type NotificationDocument = HydratedDocument<IInAppNotification>;

// ============================================
// SCHEMA
// ============================================

const notificationSchema = new Schema<IInAppNotification>(
  {
    organizationId: { type: String, required: true },
    userId: { type: String, required: true },
    type: { type: String, required: true },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    data: {
      link: { type: String, trim: true },
      entityId: { type: String, trim: true },
      entityType: { type: String, trim: true },
      meta: { type: Schema.Types.Mixed },
    },
    read: { type: Boolean, default: false },
    readAt: { type: Date, default: null },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high'],
      default: 'normal',
    },
  },
  { timestamps: true },
);

// Primary query index: user's notifications in a branch, sorted by recent
notificationSchema.index({ organizationId: 1, userId: 1, read: 1, createdAt: -1 });

// TTL: auto-expire old notifications (default 180 days, configured via env)
const ttlSeconds = parseInt(process.env.NOTIFICATION_TTL_DAYS || '180', 10) * 86400;
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: ttlSeconds });

notificationSchema.set('toJSON', { virtuals: true });
notificationSchema.set('toObject', { virtuals: true });

const InAppNotification =
  mongoose.models.InAppNotification || mongoose.model<IInAppNotification>('InAppNotification', notificationSchema);

export default InAppNotification;
