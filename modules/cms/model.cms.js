// src/models/LandingPage.js
import mongoose from 'mongoose';

const slideSchema = new mongoose.Schema({
  id: Number,
  image: {
    type: String,
    required: [true, 'Slide image URL is required']
  },
  title: String,
  subtitle: String
});

const serviceSchema = new mongoose.Schema({
  icon: String,
  title: String,
  description: String
});

const editorialSchema = new mongoose.Schema({
  title: String,
  subtitle: String,
  content: String,
  image: {
    type: String,
    required: [true, 'Editorial image URL is required']
  }
});

const landingPageSchema = new mongoose.Schema({
  hero: {
    slides: [slideSchema]
  },
  services: [serviceSchema],
  editorial: editorialSchema
}, { timestamps: true });

const LandingPage = mongoose.model('LandingPage', landingPageSchema);

export default LandingPage;
