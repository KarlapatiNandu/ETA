import { HeroCard } from "@/components/eta/hero-card";
import { LiveHome } from "@/components/live/live-home";
import { PauseButton } from "@/components/notifications/pause-button";
import { PushSetup } from "@/components/notifications/push-setup";

export default function Home() {
  return (
    <LiveHome>
      <PushSetup compact />
      <HeroCard />
      <PauseButton />
    </LiveHome>
  );
}
