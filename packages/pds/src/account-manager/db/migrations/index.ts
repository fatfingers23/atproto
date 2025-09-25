import * as mig001 from './001-init'
import * as mig002 from './002-account-deactivation'
import * as mig003 from './003-privileged-app-passwords'
import * as mig004 from './004-oauth'
import * as mig005 from './005-oauth-account-management'

export default {
  '001_account-manager': mig001,
  '002_account-manager': mig002,
  '003_account-manager': mig003,
  '004_account-manager': mig004,
  '005_account-manager': mig005,
}
