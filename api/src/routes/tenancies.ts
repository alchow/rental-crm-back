// Stable facade for the tenancy domain. App assembly and callers keep one
// import while route workflows live in focused modules under ./tenancies.
export { tenanciesApp } from './tenancies/index';
