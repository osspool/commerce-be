import mongoose from 'mongoose';
import slugPlugin from '@classytic/mongoose-slug-plugin';

/**
 * Size Guide Model
 *
 * Stores size guide templates with dynamic sizes and measurements.
 * Used for products to reference which size guide to display.
 *
 * Example:
 * {
 *   name: "T-Shirts & Tops",
 *   slug: "t-shirts-tops",
 *   description: "Size guide for t-shirts and tops",
 *   measurementUnit: "inches",
 *   sizes: [
 *     {
 *       name: "XS",
 *       measurements: { chest: "34-36", length: "26", shoulder: "16", sleeve: "7.5" }
 *     },
 *     {
 *       name: "S",
 *       measurements: { chest: "36-38", length: "27", shoulder: "17", sleeve: "8" }
 *     }
 *   ],
 *   measurementLabels: ["Chest", "Length", "Shoulder", "Sleeve"],
 *   isActive: true
 * }
 */
const sizeGuideSchema = new mongoose.Schema(
    {
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 100,
        },
        slug: {
            type: String,
        },
        description: {
            type: String,
            trim: true,
            maxlength: 500,
        },
        measurementUnit: {
            type: String,
            enum: ['inches', 'cm'],
            default: 'inches',
        },
        measurementLabels: {
            type: [String],
            default: [],
            validate: {
                validator: (v) => v.length <= 10,
                message: 'Cannot have more than 10 measurement labels',
            },
        },
        sizes: [
            {
                name: {
                    type: String,
                    required: true,
                    trim: true,
                },
                measurements: {
                    type: Map,
                    of: String,
                    default: {},
                },
                _id: false,
            },
        ],
        note: {
            type: String,
            trim: true,
            maxlength: 1000,
        },
        isActive: {
            type: Boolean,
            default: true,
        },
        displayOrder: {
            type: Number,
            default: 0,
        },
    },
    {
        timestamps: true,
        versionKey: false,
    }
);

// Indexes
sizeGuideSchema.index({ slug: 1 }, { unique: true });
sizeGuideSchema.index({ isActive: 1, displayOrder: 1 });

// Auto-slug from name (updateOnChange: regenerate slug when name is updated)
sizeGuideSchema.plugin(slugPlugin, {
    sourceField: 'name',
    slugField: 'slug',
    updateOnChange: true,
});

const SizeGuide = mongoose.model('SizeGuide', sizeGuideSchema);

export default SizeGuide;
