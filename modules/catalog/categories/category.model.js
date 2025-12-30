import mongoose from 'mongoose';
import slugPlugin from '@classytic/mongoose-slug-plugin';

const { Schema } = mongoose;

/**
 * Category Model
 *
 * Stores category metadata with slug as the primary identifier.
 * Products reference categories by slug (string), not ObjectId.
 *
 * This pattern enables:
 * - Fast product queries (no $lookup required)
 * - SEO-friendly URLs (/products/t-shirts)
 * - Rich metadata (images, descriptions)
 * - Stable references (slug doesn't change)
 *
 * Industry Standard: Shopify, WooCommerce, Square use this pattern.
 */
const categorySchema = new Schema({
    // Display name (can be changed without breaking references)
    name: {
        type: String,
        required: true,
        trim: true,
    },

    // URL-safe identifier (auto-generated from name, globally unique)
    // Products store this value in their `category` field
    slug: {
        type: String,
        required: true,
        lowercase: true,
        trim: true,
    },

    // Parent category slug (for nested categories)
    // e.g., parent: "clothing" for category "t-shirts"
    parent: {
        type: String,
        lowercase: true,
        trim: true,
        default: null,
        sparse: true,
    },

    // Short description for category listing
    description: {
        type: String,
        trim: true,
    },

    // Category image for display
    image: {
        url: { type: String, trim: true },
        alt: { type: String, trim: true },
    },

    // Display order for sorting (lower = first)
    displayOrder: {
        type: Number,
        default: 0,
    },

    // VAT configuration (category-specific rate override)
    vatRate: {
        type: Number,
        min: 0,
        max: 100,
        default: null, // null = use platform default rate
    },

    // Whether category is visible to customers
    isActive: {
        type: Boolean,
        default: true,
    },

    // Product count cache (updated by repository events)
    productCount: {
        type: Number,
        default: 0,
        min: 0,
    },

    // SEO metadata
    seo: {
        title: { type: String, trim: true },
        description: { type: String, trim: true },
        keywords: [{ type: String, trim: true }],
    },
}, { timestamps: true });

// Unique slug index
categorySchema.index({ slug: 1 }, { unique: true });

// Parent lookup for hierarchy
categorySchema.index({ parent: 1 });

// Display order for sorting
categorySchema.index({ displayOrder: 1, name: 1 });

// Active categories query
categorySchema.index({ isActive: 1, displayOrder: 1 });

// Auto-generate slug from name
categorySchema.plugin(slugPlugin, {
    sourceField: 'name',
    slugField: 'slug',
    updateOnChange: false, // Slug is immutable once created (products reference it)
});

// Virtuals
categorySchema.virtual('fullPath').get(function () {
    if (this.parent) {
        return `${this.parent}/${this.slug}`;
    }
    return this.slug;
});

categorySchema.virtual('isRoot').get(function () {
    return !this.parent;
});

categorySchema.set('toJSON', { virtuals: true });
categorySchema.set('toObject', { virtuals: true });

// Prevent deletion if products exist (safety)
categorySchema.pre('deleteOne', { document: true, query: false }, async function () {
    if (this.productCount > 0) {
        const error = new Error(`Cannot delete category "${this.name}": ${this.productCount} products still reference it`);
        error.statusCode = 409;
        throw error;
    }
});

const Category = mongoose.models.Category || mongoose.model('Category', categorySchema);
export default Category;
