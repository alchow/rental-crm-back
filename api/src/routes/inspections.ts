// Domain registrar facade. Keeping this stable avoids churn in app.ts while
// templates, inspection workflows/checks, and item CRUD evolve independently.
export { inspectionTemplatesApp } from './inspections/templates';
export { inspectionsApp } from './inspections/records';
export { inspectionItemsApp } from './inspections/items';
