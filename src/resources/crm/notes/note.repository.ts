import { Repository } from '@classytic/mongokit';
import CrmNote, { type INoteDoc } from './note.model.js';

class CrmNoteRepository extends Repository<INoteDoc> {
  constructor() {
    super(CrmNote, [], { defaultLimit: 20, maxLimit: 100 });
  }
}

const crmNoteRepository = new CrmNoteRepository();
export default crmNoteRepository;
