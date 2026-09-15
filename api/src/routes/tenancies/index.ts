import { newApiApp } from '../_lib/app';
import { tenancyRecordsApp } from './records';
import { tenancyEndingsApp } from './endings';
import { tenancyDatesApp } from './dates';
import { tenancyDateHistoryApp } from './date-history';

// One registrar keeps app assembly stable while each workflow owns its routes.
export const tenanciesApp = newApiApp();
tenanciesApp.route('/', tenancyRecordsApp);
tenanciesApp.route('/', tenancyEndingsApp);
tenanciesApp.route('/', tenancyDatesApp);
tenanciesApp.route('/', tenancyDateHistoryApp);
