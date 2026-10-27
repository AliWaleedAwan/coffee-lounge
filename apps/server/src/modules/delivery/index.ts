/** Public interface of the delivery module (other modules import only from here). */
export { deliveryRoutes, type DeliveryRouteOptions } from './routes.ts';
export { maskPhone } from './service.ts';
export { redactDeliveryDetails } from './privacy.ts';
