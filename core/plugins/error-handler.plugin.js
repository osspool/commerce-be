/**
 * Global Error Handler Plugin
 * 
 * Centralizes error handling across all modules.
 * Works with Arc errors, Mongoose errors, and custom errors.
 */

import fp from 'fastify-plugin';
import { ArcError, NotFoundError, ValidationError, UnauthorizedError, ForbiddenError } from '@classytic/arc';
import mongoose from 'mongoose';

async function errorHandlerPlugin(fastify, opts) {
  fastify.setErrorHandler((error, request, reply) => {
    // Arc framework errors
    if (error instanceof ArcError) {
      return reply.code(error.statusCode || 500).send({
        success: false,
        message: error.message,
        code: error.code,
        ...(error.details && { details: error.details })
      });
    }

    // Mongoose validation errors (check both instanceof and name for resilience)
    if (error instanceof mongoose.Error.ValidationError || error.name === 'ValidationError') {
      const messages = error.errors
        ? Object.values(error.errors).map(err => err.message)
        : [error.message];
      return reply.code(400).send({
        success: false,
        message: 'Validation error',
        errors: messages
      });
    }

    // Mongoose cast errors (invalid ObjectId, etc)
    if (error instanceof mongoose.Error.CastError) {
      return reply.code(400).send({
        success: false,
        message: `Invalid ${error.path}: ${error.value}`
      });
    }

    // MongoDB duplicate key error
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern || {})[0] || 'field';
      return reply.code(400).send({
        success: false,
        message: `${field.charAt(0).toUpperCase() + field.slice(1)} already exists`
      });
    }

    // Custom errors with statusCode
    if (error.statusCode) {
      return reply.code(error.statusCode).send({
        success: false,
        message: error.message || 'An error occurred',
        ...(error.code && { code: error.code })
      });
    }

    // JWT errors
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return reply.code(401).send({
        success: false,
        message: 'Invalid or expired token'
      });
    }

    // Default 500 error
    request.log.error({ err: error }, 'Unhandled error');
    
    return reply.code(500).send({
      success: false,
      message: process.env.NODE_ENV === 'production' 
        ? 'Internal server error' 
        : error.message || 'Internal server error'
    });
  });
}

export default fp(errorHandlerPlugin, {
  name: 'error-handler',
  fastify: '5.x'
});
