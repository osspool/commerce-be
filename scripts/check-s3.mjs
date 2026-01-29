import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
  console.error('Error: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables are required');
  process.exit(1);
}

const client = new S3Client({
  region: process.env.AWS_REGION || 'eu-north-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

try {
  const data = await client.send(new ListObjectsV2Command({
    Bucket: 'bigbossltd',
    Prefix: 'general/',
    MaxKeys: 5
  }));

  console.log('S3 Objects in general/ folder:');
  if (data.Contents && data.Contents.length > 0) {
    data.Contents.forEach(obj => {
      console.log(`  ${obj.Key} - Size: ${obj.Size} bytes - Modified: ${obj.LastModified}`);
    });
  } else {
    console.log('  No objects found');
  }

  // Check specific file
  const specificKey = 'general/1765311109921-2dd4240ea22d-pshot-3.jpeg';
  console.log(`\nChecking specific file: ${specificKey}`);
  try {
    const headData = await client.send(new GetObjectCommand({
      Bucket: 'bigbossltd',
      Key: specificKey
    }));
    console.log(`  File exists! ContentLength: ${headData.ContentLength} bytes`);
    console.log(`  ContentType: ${headData.ContentType}`);
  } catch (e) {
    console.log(`  File NOT found: ${e.message}`);
  }

  process.exit(0);
} catch (e) {
  console.error('S3 Error:', e.message);
  console.error('Full error:', e);
  process.exit(1);
}
