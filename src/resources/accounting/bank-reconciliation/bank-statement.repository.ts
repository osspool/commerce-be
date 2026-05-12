import { type AnyDocument, type AnyModel, Repository } from '@classytic/mongokit';
import BankStatement from './bank-statement.model.js';

const bankStatementRepository = new Repository<AnyDocument>(
  BankStatement as unknown as AnyModel,
  [],
  { maxLimit: 100 },
);

export default bankStatementRepository;
