import { defineResource } from '@classytic/arc';
import platformConfigController from './platform.controller.js';
import { platformActions } from '#shared/permissions.js';

const platformResource = defineResource({
  name: 'platform',
  displayName: 'Platform',
  tag: 'Platform',
  prefix: '/platform',

  disableDefaultRoutes: true,

  additionalRoutes: [
    {
      method: 'GET',
      path: '/config',
      summary: 'Get platform configuration',
      description: 'Returns full config or selected fields via ?select=field1,field2',
      permissions: platformActions.getConfig,
      wrapHandler: false,
      handler: platformConfigController.getConfig.bind(platformConfigController),
    },
    {
      method: 'PATCH',
      path: '/config',
      summary: 'Update platform configuration',
      permissions: platformActions.updateConfig,
      wrapHandler: false,
      handler: platformConfigController.updateConfig.bind(platformConfigController),
    },
  ],
});

export default platformResource;
