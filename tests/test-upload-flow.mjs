import sharp from 'sharp';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('Error: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables are required');
  process.exit(1);
}

console.log('Testing complete upload flow...\n');

const client = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

try {
  // Step 1: Create test image buffer
  console.log('Step 1: Creating test image (300x400 JPEG)...');
  const originalBuffer = await sharp({
    create: {
      width: 300,
      height: 400,
      channels: 4,
      background: { r: 100, g: 150, b: 200, alpha: 1 }
    }
  })
  .jpeg()
  .toBuffer();

  console.log(`✓ Created: ${originalBuffer.length} bytes\n`);

  // Step 2: Process image (like media-kit does)
  console.log('Step 2: Processing image with aspect ratio (3:4)...');
  const aspectRatio = 3/4;
  const maxWidth = 2048;
  const metadata = await sharp(originalBuffer).metadata();

  const targetWidth = Math.min(metadata.width, maxWidth);
  const targetHeight = Math.round(targetWidth / aspectRatio);

  const processedBuffer = await sharp(originalBuffer)
    .resize(targetWidth, targetHeight, {
      fit: 'cover',
      position: 'center'
    })
    .webp({ quality: 80 })
    .toBuffer();

  const processedMeta = await sharp(processedBuffer).metadata();
  console.log(`✓ Processed: ${processedBuffer.length} bytes`);
  console.log(`  Dimensions: ${processedMeta.width}x${processedMeta.height}`);
  console.log(`  Format: ${processedMeta.format}\n`);

  // Step 3: Upload to S3
  const testKey = `general/test-${Date.now()}.webp`;
  console.log(`Step 3: Uploading to S3 (key: ${testKey})...`);

  await client.send(new PutObjectCommand({
    Bucket: 'bigbossltd',
    Key: testKey,
    Body: processedBuffer,
    ContentType: 'image/webp',
  }));

  console.log('✓ Upload completed\n');

  // Step 4: Verify upload
  console.log('Step 4: Verifying uploaded file...');
  const headResponse = await client.send(new HeadObjectCommand({
    Bucket: 'bigbossltd',
    Key: testKey
  }));

  console.log(`✓ File verified on S3:`);
  console.log(`  ContentLength: ${headResponse.ContentLength} bytes`);
  console.log(`  ContentType: ${headResponse.ContentType}`);
  console.log(`  LastModified: ${headResponse.LastModified}`);

  const url = `https://bigbossltd.s3.eu-north-1.amazonaws.com/${testKey}`;
  console.log(`  URL: ${url}\n`);

  if (headResponse.ContentLength === processedBuffer.length) {
    console.log('✅ SUCCESS! Upload flow is working correctly.');
    console.log('   The buffer was properly uploaded to S3 with correct size.\n');
  } else {
    console.log('❌ WARNING! File size mismatch:');
    console.log(`   Expected: ${processedBuffer.length} bytes`);
    console.log(`   Got: ${headResponse.ContentLength} bytes\n`);
  }

  // Step 5: Check bucket public access
  console.log('Step 5: Testing public access...');
  console.log(`   Attempting to fetch: ${url}`);

  try {
    const response = await fetch(url);
    if (response.ok) {
      console.log('✅ Public access is working! Image is publicly accessible.\n');
    } else {
      console.log(`❌ Public access FAILED: HTTP ${response.status} ${response.statusText}`);
      console.log('   Your S3 bucket might not be configured for public access.');
      console.log('   Images won\'t display in browsers without proper bucket policy.\n');
    }
  } catch (fetchError) {
    console.log('❌ Failed to fetch image:', fetchError.message);
    console.log('   Your S3 bucket might not have public access enabled.\n');
  }

  process.exit(0);

} catch (error) {
  console.error('❌ Error:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
