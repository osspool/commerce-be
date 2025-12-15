// src/config/sections/storage.config.js

export default {
    storage: {
      type: process.env.STORAGE_TYPE || "s3",
      s3: {
        bucket: process.env.S3_BUCKET_NAME,
        publicUrl: process.env.S3_PUBLIC_URL, // CloudFront or custom domain (optional)
      },
    },

    aws: {
      region: process.env.AWS_REGION,
      accessKeyId: process.env.AWS_ACCESS_KEY,
      secretAccessKey: process.env.AWS_SECRET_KEY,
    },
  };