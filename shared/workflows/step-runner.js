/**
 * Step Runner
 * Execute individual workflow steps with retry and error handling
 * For future complex integrations (payment gateways, email, etc)
 */

/**
 * Execute a step with retry logic
 */
export async function executeStep(step, context, logger, options = {}) {
  const { maxRetries = 3, retryDelay = 1000 } = options;
  
  context.currentStep = step.config.name;
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      logger?.info(`Executing step: ${step.config.name}`, { attempt: attempt + 1 });
      
      const result = await step.handler(context, logger);
      
      context.recordStep(step.config.name, 'success', result);
      logger?.info(`Step completed: ${step.config.name}`);
      
      return result;
    } catch (error) {
      attempt++;
      logger?.error(`Step failed: ${step.config.name}`, { 
        error: error.message, 
        attempt 
      });

      if (attempt >= maxRetries) {
        context.recordStep(step.config.name, 'failed', null, error);
        throw error;
      }

      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, retryDelay * attempt));
    }
  }
}

/**
 * Execute multiple steps in sequence
 */
export async function executeSteps(steps, context, logger) {
  for (const step of steps) {
    await executeStep(step, context, logger);
  }
  return context;
}

