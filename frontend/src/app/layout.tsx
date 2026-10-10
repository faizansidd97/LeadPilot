import type { Metadata } from 'next';
import {connection} from 'next/server';
import './globals.css';
export const metadata: Metadata = {title:'LeadPilot AI',description:'A focused workspace for real estate leads and follow ups.'};
export default async function Layout({children}:{children:React.ReactNode}) { await connection();return <html lang="en"><body>{children}</body></html>; }
