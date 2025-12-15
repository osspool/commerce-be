import sharp from 'sharp';
import fs from 'fs/promises';

console.log('Testing Sharp image processing...\n');

// Test 1: Create a simple test image
console.log('Test 1: Creating test buffer...');
try {
  const testBuffer = await sharp({
    create: {
      width: 100,
      height: 100,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 }
    }
  })
  .png()
  .toBuffer();

  console.log('✓ Test buffer created:', testBuffer.length, 'bytes\n');

  // Test 2: Process with similar settings to media-kit
  console.log('Test 2: Processing with media-kit settings...');
  const processed = await sharp(testBuffer)
    .resize(2048, null, {
      fit: 'inside',
      withoutEnlargement: true
    })
    .webp({ quality: 80 })
    .toBuffer();

  const metadata = await sharp(processed).metadata();
  console.log('✓ Processed successfully');
  console.log('  Output size:', processed.length, 'bytes');
  console.log('  Dimensions:', `${metadata.width}x${metadata.height}`);
  console.log('  Format:', metadata.format, '\n');

  // Test 3: Test with aspect ratio (like product: 3/4)
  console.log('Test 3: Processing with aspect ratio (3:4)...');
  const aspectTest = await sharp(testBuffer)
    .resize(100, Math.round(100 / (3/4)), {
      fit: 'cover',
      position: 'center'
    })
    .webp({ quality: 80 })
    .toBuffer();

  const aspectMeta = await sharp(aspectTest).metadata();
  console.log('✓ Aspect ratio processing successful');
  console.log('  Dimensions:', `${aspectMeta.width}x${aspectMeta.height}`);
  console.log('  Aspect ratio:', (aspectMeta.width / aspectMeta.height).toFixed(2), '\n');

  // Test 4: Generate variants
  console.log('Test 4: Generating size variants...');
  const variants = [
    { name: 'thumbnail', width: 150, height: 200 },
    { name: 'medium', width: 600, height: 800 },
    { name: 'large', width: 1200, height: 1600 },
  ];

  for (const variant of variants) {
    const variantBuffer = await sharp(testBuffer)
      .resize(variant.width, variant.height, {
        fit: 'cover',
        position: 'center'
      })
      .webp({ quality: 75 })
      .toBuffer();

    const variantMeta = await sharp(variantBuffer).metadata();
    console.log(`  ✓ ${variant.name}: ${variantMeta.width}x${variantMeta.height} (${variantBuffer.length} bytes)`);
  }

  console.log('\n✅ All tests passed! Sharp is working correctly.');
  process.exit(0);

} catch (error) {
  console.error('❌ Error during processing:', error.message);
  console.error('Stack:', error.stack);
  process.exit(1);
}
