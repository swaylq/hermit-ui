// Settings → Pi Runtime became Settings → Models: it was never a pi page, and
// three harnesses wanted what was on it. The path stays alive because it is in
// the fleet's docs and in people's bookmarks.
import { redirect } from 'next/navigation';

export default function PiSettingsRedirect() {
  redirect('/models');
}
