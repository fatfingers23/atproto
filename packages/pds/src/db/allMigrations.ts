import account_manager_migrations from '../account-manager/db/migrations'
import did_doc_migrations from '../did-cache/db/migrations'
// let result = {}
//
// Object.keys(did_doc_migrations).forEach((key) => {
//   result[key] = did_doc_migrations[key]
// })

export default {
  ...did_doc_migrations,
  ...account_manager_migrations,
}
