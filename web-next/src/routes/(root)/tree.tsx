import { ForceGraph } from "~/components/ForceGraph.tsx";

export default function Tree() {
  return (
    <div class="h-full flex flex-col">
      <div class="border overflow-hidden w-full max-h-full flex-1">
        <ForceGraph />
      </div>
    </div>
  );
}
