# Integrations Directory

This directory contains 3rd party service integrations.

## Structure

```
integrations/
├── payment/
│   ├── bkash.service.js      # bKash payment gateway
│   ├── stripe.service.js     # Stripe integration
│   └── payment.interface.js  # Common interface
├── email/
│   ├── smtp.service.js       # Email sending
│   └── templates/            # Email templates
├── storage/
│   ├── s3.service.js         # AWS S3
│   └── cloudinary.service.js # Cloudinary
└── sms/
    └── twilio.service.js     # SMS notifications
```

## Future Integration Example

When adding payment gateway:

1. Create service in `integrations/payment/`
2. Create step-based workflow in `modules/course/enrollment/workflows-advanced/`
3. Use `WorkflowContext` + `step-runner` for complex flows
4. Keep simple workflows in `enrollment.workflows.js`

## Best Practices

- ✅ Use step-based for 3rd party APIs
- ✅ Use simple workflows for internal logic
- ✅ All integrations implement common interface
- ✅ Error handling and retry built-in

