// ESM entry point. Deliberately a thin re-export of `index.cjs` rather than a
// second copy of the implementation: two entry points that each own their own
// code is how a dual package ends up with two subtly different `resolve()`s.
// There is exactly one implementation; this file only changes the doorway.
//
// Named imports from a CJS file work through Node's cjs-module-lexer, but only
// for statically analysable `module.exports` shapes — importing the default and
// re-exporting off it is immune to that, and to bundlers that analyse less.
import client from './index.cjs'

export const VehiclesDB = client.VehiclesDB
export const VehiclesDBError = client.VehiclesDBError
export const VehiclesDBApiError = client.VehiclesDBApiError
export const VehiclesDBAuthError = client.VehiclesDBAuthError
export const VehiclesDBPaymentRequiredError = client.VehiclesDBPaymentRequiredError
export const VehiclesDBRateLimitError = client.VehiclesDBRateLimitError
export const VehiclesDBNotFoundError = client.VehiclesDBNotFoundError
export const VehiclesDBTimeoutError = client.VehiclesDBTimeoutError
export const VehiclesDBConfigError = client.VehiclesDBConfigError
export const KIND_PRECEDENCE = client.KIND_PRECEDENCE
export const ATTRIBUTION = client.ATTRIBUTION
export const normalize = client.normalize

export default client
