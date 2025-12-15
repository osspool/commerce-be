/**
 * S3 Utilities
 * 
 * Low-level S3 operations for direct usage.
 * 
 * NOTE: For media management, use the media plugin instead:
 * fastify.media.upload(), fastify.media.delete(), etc.
 * 
 * This utility is for other S3 operations outside of media management.
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import appConfig from "../config/index.js";
import sharp from "sharp";
import crypto from "crypto";

const s3 = new S3Client({
  region: appConfig.aws.region,
  credentials: {
    accessKeyId: appConfig.aws.accessKeyId,
    secretAccessKey: appConfig.aws.secretAccessKey,
  },
});

// Default aspect ratio presets
const DEFAULT_ASPECT_RATIOS = {
  product: { aspectRatio: 3/4, fit: 'cover' },
  category: { aspectRatio: 1, fit: 'cover' },
  banner: { aspectRatio: 16/9, fit: 'cover' },
  avatar: { aspectRatio: 1, fit: 'cover' },
  default: { preserveRatio: true },
};

/**
 * Uploads an image to S3, automatically converts to webp with smart aspect ratio handling
 * @param {Buffer} fileBuffer - Image buffer
 * @param {string} fileName - Original filename
 * @param {string} folderPath - S3 folder path
 * @param {Object} options - Upload options
 * @param {string} options.contentType - Content type (product, category, etc.)
 * @param {number} options.maxWidth - Maximum width (default: 2048)
 * @param {Object} options.aspectRatios - Custom aspect ratio presets
 * @returns {Promise<string>} S3 URL
 */
export const uploadFile = async (fileBuffer, fileName, folderPath, options = {}) => {
  try {
    const { 
      contentType, 
      maxWidth = 2048, 
      aspectRatios = DEFAULT_ASPECT_RATIOS 
    } = options;

    // Get aspect ratio config based on content type
    const ratioConfig = aspectRatios[contentType] || aspectRatios.default || DEFAULT_ASPECT_RATIOS.default;

    // Get image metadata
    const metadata = await sharp(fileBuffer).metadata();

    let sharpInstance = sharp(fileBuffer);

    // Apply aspect ratio transformation
    if (ratioConfig.preserveRatio) {
      // Preserve original aspect ratio, only resize if too large
      if (metadata.width > maxWidth) {
        sharpInstance = sharpInstance.resize(maxWidth, null, {
          fit: 'inside',
          withoutEnlargement: true
        });
      }
    } else {
      // Apply specific aspect ratio
      const targetWidth = Math.min(metadata.width, maxWidth);
      const targetHeight = Math.round(targetWidth / ratioConfig.aspectRatio);

      sharpInstance = sharpInstance.resize(targetWidth, targetHeight, {
        fit: ratioConfig.fit,
        position: 'center'
      });
    }

    // Convert to webp
    const webpBuffer = await sharpInstance
      .webp({ quality: 80 })
      .toBuffer();

    // Generate unique filename
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(6).toString("hex");
    const baseName = fileName.replace(/\.[^/.]+$/, ""); // Remove extension
    const key = `${folderPath}/${timestamp}-${randomStr}-${baseName}.webp`;

    const params = {
      Bucket: appConfig.storage.s3.bucket,
      Key: key,
      Body: webpBuffer,
      ContentType: "image/webp",
      ACL: "public-read",
    };

    const command = new PutObjectCommand(params);
    await s3.send(command);

    // Return the URL
    const fileUrl = appConfig.storage.s3.publicUrl
      ? `${appConfig.storage.s3.publicUrl}/${key}`
      : `https://${appConfig.storage.s3.bucket}.s3.${appConfig.aws.region}.amazonaws.com/${key}`;

    return fileUrl;
  } catch (error) {
    console.error("Error uploading file to S3:", error);
    throw new Error("Error uploading file to S3");
  }
};

/**
 * Deletes a file from S3
 * @param {string} fileUrl - S3 file URL or key
 * @returns {Promise<boolean>}
 */
export const deleteFile = async (fileUrl) => {
  try {
    // Extract key from URL
    const urlParts = fileUrl.split(".amazonaws.com/");
    const key = urlParts.length === 2 
      ? urlParts[1] 
      : appConfig.storage.s3.publicUrl 
        ? fileUrl.split(`${appConfig.storage.s3.publicUrl}/`)[1]
        : fileUrl;

    if (!key) {
      throw new Error("Invalid S3 file URL");
    }

    const params = {
      Bucket: appConfig.storage.s3.bucket,
      Key: decodeURIComponent(key),
    };

    const command = new DeleteObjectCommand(params);
    await s3.send(command);

    return true;
  } catch (error) {
    console.error("Error deleting file from S3:", error);
    throw new Error("Error deleting file from S3");
  }
};

/**
 * Gets a file stream from S3
 * @param {string} key - S3 object key
 * @returns {Promise<ReadableStream>}
 */
export const getFileStream = async (key) => {
  try {
    const params = {
      Bucket: appConfig.storage.s3.bucket,
      Key: key,
    };

    const command = new GetObjectCommand(params);
    const response = await s3.send(command);

    return response.Body;
  } catch (error) {
    console.error("Error getting file stream from S3:", error);
    throw new Error("Error getting file stream from S3");
  }
};
