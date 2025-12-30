/**
 * Workflow Context
 * Shared context for step-based workflows
 * Inspired by Temporal.io and Netflix Conductor
 */

export class WorkflowContext {
  constructor(initialData = {}) {
    this.data = { ...initialData };
    this.steps = [];
    this.currentStep = null;
    this.metadata = {
      startedAt: new Date(),
      completedAt: null,
      status: 'pending', // pending, running, completed, failed
    };
  }

  /**
   * Set data for current step
   */
  set(key, value) {
    this.data[key] = value;
  }

  /**
   * Get data from context
   */
  get(key) {
    return this.data[key];
  }

  /**
   * Record step execution
   */
  recordStep(stepName, status, result = null, error = null) {
    const step = {
      name: stepName,
      status,
      result,
      error: error?.message,
      executedAt: new Date(),
    };
    this.steps.push(step);
    return step;
  }

  /**
   * Mark workflow as completed
   */
  complete(result) {
    this.metadata.status = 'completed';
    this.metadata.completedAt = new Date();
    this.data.result = result;
  }

  /**
   * Mark workflow as failed
   */
  fail(error) {
    this.metadata.status = 'failed';
    this.metadata.completedAt = new Date();
    this.data.error = error.message;
  }

  /**
   * Get workflow summary
   */
  getSummary() {
    return {
      ...this.metadata,
      totalSteps: this.steps.length,
      completedSteps: this.steps.filter(s => s.status === 'success').length,
      failedSteps: this.steps.filter(s => s.status === 'failed').length,
      duration: this.metadata.completedAt 
        ? this.metadata.completedAt - this.metadata.startedAt 
        : Date.now() - this.metadata.startedAt,
    };
  }
}

