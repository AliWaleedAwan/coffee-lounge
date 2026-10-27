/** Public interface of the assets module (other modules import only from here). */
export { assetRoutes } from './routes.ts';
export {
  changeAsset,
  registerAsset,
  type AssetChanges,
  type AssetInput,
  type By,
} from './service.ts';
