import * as d3 from "d3";
import { onCleanup, onMount } from "solid-js";

interface NodeDatum {
  id: string;
  username?: string;
  name?: string;
  avatarUrl: string;
  hidden: boolean;
  x?: number;
  y?: number;
  fx?: number | null;
  fy?: number | null;
}

interface LinkDatum {
  source: string | NodeDatum;
  target: string | NodeDatum;
  value: number;
}

export interface GraphData {
  nodes: NodeDatum[];
  links: LinkDatum[];
}

export interface ForceGraphProps {
  width?: number;
  height?: number;
  data: GraphData;
}

const NODE_RADIUS = 16;

export function ForceGraph(props: ForceGraphProps) {
  let svgRef: SVGSVGElement | undefined;

  const width = () => props.width ?? 800;
  const height = () => props.height ?? 600;

  onMount(() => {
    if (!svgRef) return;

    const data = props.data;

    // Create copies of data
    const links: LinkDatum[] = data.links.map((d) => ({ ...d }));
    const nodes: NodeDatum[] = data.nodes.map((d) => ({ ...d }));

    // Create simulation with forces
    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink<NodeDatum, LinkDatum>(links)
          .id((d: NodeDatum) => d.id)
          .distance(80)
          .strength(0.8),
      )
      .force("charge", d3.forceManyBody().strength(-400))
      .force("x", d3.forceX().strength(0.05))
      .force("y", d3.forceY().strength(0.05))
      .force("collision", d3.forceCollide().radius(NODE_RADIUS + 4));

    // Create SVG
    const svg = d3
      .select(svgRef)
      .attr("viewBox", [-width() / 2, -height() / 2, width(), height()]);

    // Clear previous content
    svg.selectAll("*").remove();

    // Create defs for clip paths
    const defs = svg.append("defs");

    // Create clip paths for each node
    nodes.forEach((node) => {
      defs
        .append("clipPath")
        .attr("id", `clip-${node.id}`)
        .append("circle")
        .attr("r", NODE_RADIUS);
    });

    // Create container group for zoom/pan
    const g = svg.append("g");

    // Add zoom behavior
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.25, 4])
      .on("zoom", (event: d3.D3ZoomEvent<SVGSVGElement, unknown>) => {
        g.attr("transform", event.transform.toString());
      });

    svg.call(zoom);

    // Double-click to reset zoom
    svg.on("dblclick.zoom", () => {
      svg.transition().duration(300).call(zoom.transform, d3.zoomIdentity);
    });

    // Add links
    const link = g
      .append("g")
      .attr("stroke", "currentColor")
      .attr("stroke-opacity", 0.3)
      .attr("fill", "none")
      .selectAll<SVGLineElement, LinkDatum>("line")
      .data(links)
      .join("line")
      .attr("stroke-width", 1);

    // Create node groups
    const node = g
      .append("g")
      .selectAll<SVGGElement, NodeDatum>("g")
      .data(nodes)
      .join("g")
      .style("cursor", "grab")
      .attr("opacity", (d: NodeDatum) => (d.hidden ? 0.5 : 1));

    // Add avatar images with circular clip
    node
      .append("image")
      .attr("href", (d: NodeDatum) => d.avatarUrl)
      .attr("width", NODE_RADIUS * 2)
      .attr("height", NODE_RADIUS * 2)
      .attr("x", -NODE_RADIUS)
      .attr("y", -NODE_RADIUS)
      .attr("clip-path", (d: NodeDatum) => `url(#clip-${d.id})`)
      .attr("preserveAspectRatio", "xMidYMid slice");

    // Add circle border
    node
      .append("circle")
      .attr("r", NODE_RADIUS)
      .attr("fill", "none")
      .attr("stroke", (d: NodeDatum) => (d.hidden ? "#9ca3af" : "#e5e7eb"))
      .attr("stroke-width", 2)
      .attr("stroke-dasharray", (d: NodeDatum) => (d.hidden ? "4,2" : "none"));

    // Add username label (or "hidden" for hidden accounts)
    node
      .append("text")
      .text((d: NodeDatum) => (d.hidden ? "🔒" : d.username ?? ""))
      .attr("x", 0)
      .attr("y", NODE_RADIUS + 14)
      .attr("text-anchor", "middle")
      .attr("font-size", "10px")
      .attr("fill", "currentColor")
      .attr("opacity", 0.8);

    // Add titles for hover
    node
      .append("title")
      .text((d: NodeDatum) =>
        d.hidden ? "Hidden account" : `${d.name} (@${d.username})`
      );

    // Add drag behavior
    const drag = d3
      .drag<SVGGElement, NodeDatum>()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended);

    function dragstarted(
      event: d3.D3DragEvent<SVGGElement, NodeDatum, NodeDatum>,
      d: NodeDatum,
    ) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(
      event: d3.D3DragEvent<SVGGElement, NodeDatum, NodeDatum>,
      d: NodeDatum,
    ) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(
      event: d3.D3DragEvent<SVGGElement, NodeDatum, NodeDatum>,
      d: NodeDatum,
    ) {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null;
      d.fy = null;
    }

    node.call(drag);

    // Update positions on tick
    simulation.on("tick", () => {
      link
        .attr("x1", (d: LinkDatum) => (d.source as NodeDatum).x ?? 0)
        .attr("y1", (d: LinkDatum) => (d.source as NodeDatum).y ?? 0)
        .attr("x2", (d: LinkDatum) => (d.target as NodeDatum).x ?? 0)
        .attr("y2", (d: LinkDatum) => (d.target as NodeDatum).y ?? 0);

      node.attr("transform", (d: NodeDatum) => `translate(${d.x},${d.y})`);
    });

    onCleanup(() => {
      simulation.stop();
    });
  });

  return <svg ref={svgRef} class="w-full h-full touch-none" />;
}
