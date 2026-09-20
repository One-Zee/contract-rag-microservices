import { DOCUMENT_STATUSES, DOCUMENT_VISIBILITIES } from '@app/common';
import { documentStatus, documentVisibility } from './documents.js';

describe('document enums', () => {
  it('document_status matches DOCUMENT_STATUSES from @app/common', () => {
    expect([...documentStatus.enumValues]).toEqual([...DOCUMENT_STATUSES]);
  });

  it('document_visibility matches DOCUMENT_VISIBILITIES from @app/common', () => {
    expect([...documentVisibility.enumValues]).toEqual([
      ...DOCUMENT_VISIBILITIES,
    ]);
  });
});
