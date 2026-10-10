import Workspace from '@/components/workspace';
import ConnectedWorkspace from '@/components/connected-workspace';
import { configured } from '@leadpilot/backend/server/supabase';
export default function Page(){return configured()?<ConnectedWorkspace/>:<Workspace/>;}
