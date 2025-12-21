#!/usr/bin/env node

/**
 * Seed Categories Script
 *
 * Populates the database with default product categories.
 * Safe to run multiple times - uses upsert to avoid duplicates.
 *
 * Usage:
 *   node modules/commerce/category/seed-categories.js
 *
 * Environment:
 *   MONGO_URI - MongoDB connection string (required)
 */

import mongoose from 'mongoose';
import 'dotenv/config';
import Category from './category.model.js';

// ============================================
// CATEGORY DATA
// ============================================

const CATEGORIES = {
  men: {
    label: 'Men',
    slug: 'men',
    image: 'https://images.unsplash.com/photo-1617137968427-85924c800a22?w=400&h=500&fit=crop',
    subcategories: [
      { label: 'T-Shirts', slug: 't-shirts', image: 'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=100&h=100&fit=crop' },
      { label: 'Hoodies', slug: 'hoodies', image: 'https://images.unsplash.com/photo-1556821840-3a63f95609a7?w=100&h=100&fit=crop' },
      { label: 'Jackets', slug: 'jackets', image: 'https://images.unsplash.com/photo-1551028719-00167b16eac5?w=100&h=100&fit=crop' },
      { label: 'Pants', slug: 'pants', image: 'https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=100&h=100&fit=crop' },
      { label: 'Shorts', slug: 'shorts', image: 'https://images.unsplash.com/photo-1591195853828-11db59a44f6b?w=100&h=100&fit=crop' },
      { label: 'Accessories', slug: 'accessories', image: 'https://images.unsplash.com/photo-1523170335258-f5ed11844a49?w=100&h=100&fit=crop' },
    ],
  },
  women: {
    label: 'Women',
    slug: 'women',
    image: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=400&h=500&fit=crop',
    subcategories: [
      { label: 'Tops', slug: 'tops', image: 'https://images.unsplash.com/photo-1564257631407-4deb1f99d992?w=100&h=100&fit=crop' },
      { label: 'Dresses', slug: 'dresses', image: 'https://images.unsplash.com/photo-1595777457583-95e059d581b8?w=100&h=100&fit=crop' },
      { label: 'Hoodies', slug: 'hoodies', image: 'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=100&h=100&fit=crop' },
      { label: 'Pants', slug: 'pants', image: 'https://images.unsplash.com/photo-1594938298603-c8148c4dae35?w=100&h=100&fit=crop' },
      { label: 'Skirts', slug: 'skirts', image: 'https://images.unsplash.com/photo-1583496661160-fb5886a0uj3a?w=100&h=100&fit=crop' },
      { label: 'Accessories', slug: 'accessories', image: 'https://images.unsplash.com/photo-1611923134239-b9be5816e23c?w=100&h=100&fit=crop' },
    ],
  },
  kids: {
    label: 'Kids',
    slug: 'kids',
    image: 'https://images.unsplash.com/photo-1503919545889-aef636e10ad4?w=400&h=500&fit=crop',
    subcategories: [
      { label: 'Boys', slug: 'boys', image: 'https://images.unsplash.com/photo-1519238263530-99bdd11df2ea?w=100&h=100&fit=crop' },
      { label: 'Girls', slug: 'girls', image: 'https://images.unsplash.com/photo-1518831959646-742c3a14ebf7?w=100&h=100&fit=crop' },
    ],
  },
  collections: {
    label: 'Collections',
    slug: 'collections',
    image: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=400&h=500&fit=crop',
    subcategories: [
      { label: 'New Arrivals', slug: 'new-arrivals', image: 'https://images.unsplash.com/photo-1445205170230-053b83016050?w=100&h=100&fit=crop' },
      { label: 'Best Sellers', slug: 'best-sellers', image: 'https://images.unsplash.com/photo-1441984904996-e0b6ba687e04?w=100&h=100&fit=crop' },
      { label: 'Sale', slug: 'sale', image: 'https://images.unsplash.com/photo-1607082348824-0a96f2a4b9da?w=100&h=100&fit=crop' },
      { label: 'Limited Edition', slug: 'limited-edition', image: 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=100&h=100&fit=crop' },
    ],
  },
};

// ============================================
// TRANSFORM TO MODEL FORMAT
// ============================================

/**
 * Transforms the category data to match the Category model schema.
 * Creates unique slugs for subcategories by prefixing with parent slug.
 */
function buildCategoryDocuments() {
  const documents = [];
  let displayOrder = 0;

  for (const [key, category] of Object.entries(CATEGORIES)) {
    // Parent category
    documents.push({
      name: category.label,
      slug: category.slug,
      parent: null,
      description: `Shop ${category.label}'s collection`,
      image: {
        url: category.image,
        alt: `${category.label} category`,
      },
      displayOrder: displayOrder++,
      isActive: true,
      productCount: 0,
      seo: {
        title: `${category.label} - Shop Now`,
        description: `Browse our ${category.label.toLowerCase()} collection`,
        keywords: [category.label.toLowerCase()],
      },
    });

    // Subcategories with parent reference
    for (const sub of category.subcategories) {
      // Create unique slug: parent-slug/sub-slug (e.g., "men-t-shirts")
      const uniqueSlug = `${category.slug}-${sub.slug}`;

      documents.push({
        name: sub.label,
        slug: uniqueSlug,
        parent: category.slug,
        description: `${sub.label} for ${category.label}`,
        image: {
          url: sub.image,
          alt: `${sub.label} - ${category.label}`,
        },
        displayOrder: displayOrder++,
        isActive: true,
        productCount: 0,
        seo: {
          title: `${sub.label} for ${category.label}`,
          description: `Shop ${sub.label.toLowerCase()} in our ${category.label.toLowerCase()} collection`,
          keywords: [sub.label.toLowerCase(), category.label.toLowerCase()],
        },
      });
    }
  }

  return documents;
}

// ============================================
// SEED FUNCTION
// ============================================

async function seedCategories() {
  console.log('='.repeat(60));
  console.log('Seed Categories');
  console.log('='.repeat(60));

  const uri = process.env.MONGO_URI;
  if (!uri) {
    console.error('Error: MONGO_URI environment variable is required');
    process.exit(1);
  }

  try {
    // Connect to database
    console.log('Connecting to database...');
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
    });
    console.log('Connected to:', mongoose.connection.name);

    // Build category documents
    const categories = buildCategoryDocuments();
    console.log(`\nPrepared ${categories.length} categories to seed`);

    // Upsert categories (update if exists, insert if not)
    let created = 0;
    let updated = 0;

    for (const category of categories) {
      const result = await Category.findOneAndUpdate(
        { slug: category.slug },
        { $set: category },
        { upsert: true, new: true, runValidators: true }
      );

      if (result.createdAt.getTime() === result.updatedAt.getTime()) {
        created++;
        console.log(`  [+] Created: ${category.name} (${category.slug})`);
      } else {
        updated++;
        console.log(`  [~] Updated: ${category.name} (${category.slug})`);
      }
    }

    console.log('\n' + '-'.repeat(40));
    console.log(`Summary: ${created} created, ${updated} updated`);
    console.log('-'.repeat(40));

    // Show category tree
    console.log('\nCategory Tree:');
    const rootCategories = await Category.find({ parent: null }).sort({ displayOrder: 1 });
    for (const root of rootCategories) {
      console.log(`  ${root.name} (${root.slug})`);
      const children = await Category.find({ parent: root.slug }).sort({ displayOrder: 1 });
      for (const child of children) {
        console.log(`    └─ ${child.name} (${child.slug})`);
      }
    }

    console.log('\n' + '='.repeat(60));
    console.log('Done!');
    console.log('='.repeat(60));

  } catch (error) {
    console.error('Seed failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
  }
}

// Run if called directly
seedCategories().catch(console.error);

export { CATEGORIES, buildCategoryDocuments, seedCategories };
