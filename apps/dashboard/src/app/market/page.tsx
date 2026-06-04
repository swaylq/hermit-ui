import { redirect } from 'next/navigation';

// /market has no view of its own — Skills is the default tab.
export default function MarketIndex() {
  redirect('/market/skills');
}
