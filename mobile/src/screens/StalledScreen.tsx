// A kept sign-in that could not be checked at start (no connection, the household busy or gone). The sign-in is
// kept: only a 401 drops it.
import { useSession } from '../session/SessionProvider';
import { STALLED_TEXT, type StalledKind } from '../signin/wording';
import { Button, Heading, Message, Page } from '../ui';

export function StalledScreen({ problem }: { problem: StalledKind }) {
  const { retry, signOut } = useSession();
  return (
    <Page>
      <Heading title="JellyPass" />
      <Message text={STALLED_TEXT[problem]} />
      <Button label="Try again" onPress={retry} />
      <Button label="Sign out" secondary onPress={() => void signOut()} />
    </Page>
  );
}
