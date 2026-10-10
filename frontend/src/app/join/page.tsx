import JoinInvitation from '@/components/join-invitation';
import {configured} from '@leadpilot/backend/server/supabase';
export const metadata={title:'Join your agency · LeadPilot',referrer:'no-referrer'};
export default function Page(){return <JoinInvitation configured={configured()}/>;}
