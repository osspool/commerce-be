import BaseController from '#common/controllers/baseController.js';
import userRepository from './user.repository.js';
import { userSchemaOptions } from './schemas.js';

/**
 * User Controller
 * Handles user CRUD operations
 *
 * Note: This is for admin user management
 * Regular users use auth routes for profile updates
 */
export class UserController extends BaseController {
  constructor(service, schemaOptions) {
    super(service, schemaOptions);
  }
}

const userController = new UserController(userRepository, userSchemaOptions);
export default userController;
