const OFFICE_ERRORS: Record<string, string> = {
  missing_file: 'Choose a file to import.',
  unsupported_document_type: 'Only .docx and .odt documents can be imported.',
  unsupported_spreadsheet_type: 'Only .xlsx and .ods spreadsheets can be imported.',
  unsupported_export_type: 'That export format is not supported.',
  office_file_too_large: 'This file is larger than the 24 MB import limit.',
  office_file_too_complex: 'This Office file expands beyond the safe conversion limit.',
  document_too_large: 'This document is too large to convert safely.',
  spreadsheet_too_large: 'This spreadsheet has too many rows, columns, cells, or sheets to convert safely.',
  converted_document_too_large: 'The converted document is too large to save safely.',
  office_export_too_large: 'The exported Office file would be too large to download safely.',
  office_conversion_timed_out: 'Conversion took too long. Try simplifying the file and import it again.',
  invalid_office_file: 'This file is damaged, encrypted, or does not match its filename extension.',
  spreadsheet_has_no_sheets: 'This workbook does not contain any sheets to import.',
  invalid_spreadsheet: 'This Aerie spreadsheet is damaged and cannot be exported.',
  native_document_required: 'Only an editable Aerie document can be exported.',
  native_spreadsheet_required: 'Only an editable Aerie spreadsheet or CSV file can be exported.',
  quota_exceeded: 'There is not enough storage space to save the editable copy.',
  storage_quota_exceeded: 'There is not enough storage space to save the editable copy.',
  storage_device_full: 'The server does not have enough free disk space to save the editable copy.',
  too_many_name_conflicts: 'Too many files already use this name. Rename the original and try again.',
};

export function officeErrorMessage(error: unknown, fallback: string): string {
  const message = String((error as any)?.message || error || '').trim();
  if (OFFICE_ERRORS[message]) return OFFICE_ERRORS[message];
  // Preserve explanatory server/network messages, but never expose an
  // untranslated machine code as the only guidance shown to the user.
  if (message && !/^[a-z][a-z0-9_]*$/i.test(message)) return message;
  return fallback;
}
