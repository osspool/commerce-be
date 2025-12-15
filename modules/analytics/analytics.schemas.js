/**
 * Analytics Schemas
 * Query validation for ecommerce dashboard analytics
 */

export const dashboardQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    period: {
      type: 'string',
      enum: ['7d', '30d'],
      default: '30d',
      description: 'Time period for analytics (7 days or 30 days)',
    },
  },
};

export default {
  dashboardQuery,
};
