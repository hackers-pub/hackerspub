import * as d3 from "d3";
import { onCleanup, onMount } from "solid-js";

interface NodeDatum {
  id: string;
  group: number;
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

interface GraphData {
  nodes: NodeDatum[];
  links: LinkDatum[];
}

// Rich tree data for beautiful visualization
const sampleData: GraphData = {
  nodes: [
    // Root (depth 0)
    { id: "Tech Stack", group: 0 },

    // Level 1 (depth 1)
    { id: "Frontend", group: 1 },
    { id: "Backend", group: 1 },
    { id: "Database", group: 1 },
    { id: "DevOps", group: 1 },
    { id: "Mobile", group: 1 },

    // Frontend children (depth 2)
    { id: "React", group: 2 },
    { id: "Vue", group: 2 },
    { id: "Solid", group: 2 },
    { id: "Svelte", group: 2 },
    { id: "Angular", group: 2 },

    // Backend children (depth 2)
    { id: "Node.js", group: 3 },
    { id: "Deno", group: 3 },
    { id: "Go", group: 3 },
    { id: "Rust", group: 3 },
    { id: "Python", group: 3 },

    // Database children (depth 2)
    { id: "PostgreSQL", group: 4 },
    { id: "MongoDB", group: 4 },
    { id: "Redis", group: 4 },
    { id: "SQLite", group: 4 },

    // DevOps children (depth 2)
    { id: "Docker", group: 5 },
    { id: "K8s", group: 5 },
    { id: "GitHub Actions", group: 5 },
    { id: "Terraform", group: 5 },

    // Mobile children (depth 2)
    { id: "React Native", group: 6 },
    { id: "Flutter", group: 6 },
    { id: "Swift", group: 6 },
    { id: "Kotlin", group: 6 },

    // React frameworks (depth 3)
    { id: "Next.js", group: 7 },
    { id: "Remix", group: 7 },
    { id: "Gatsby", group: 7 },

    // Vue frameworks (depth 3)
    { id: "Nuxt", group: 7 },
    { id: "Vite", group: 7 },

    // Solid frameworks (depth 3)
    { id: "SolidStart", group: 7 },

    // Svelte frameworks (depth 3)
    { id: "SvelteKit", group: 7 },

    // Node.js frameworks (depth 3)
    { id: "Express", group: 8 },
    { id: "Fastify", group: 8 },
    { id: "NestJS", group: 8 },

    // Deno frameworks (depth 3)
    { id: "Fresh", group: 8 },
    { id: "Hono", group: 8 },
    { id: "Oak", group: 8 },

    // Go frameworks (depth 3)
    { id: "Gin", group: 8 },
    { id: "Echo", group: 8 },

    // Python frameworks (depth 3)
    { id: "FastAPI", group: 8 },
    { id: "Django", group: 8 },
    { id: "Flask", group: 8 },

    // Rust frameworks (depth 3)
    { id: "Actix", group: 8 },
    { id: "Axum", group: 8 },
  ],
  links: [
    // Root -> Level 1
    { source: "Tech Stack", target: "Frontend", value: 4 },
    { source: "Tech Stack", target: "Backend", value: 4 },
    { source: "Tech Stack", target: "Database", value: 4 },
    { source: "Tech Stack", target: "DevOps", value: 4 },
    { source: "Tech Stack", target: "Mobile", value: 4 },

    // Frontend -> frameworks
    { source: "Frontend", target: "React", value: 3 },
    { source: "Frontend", target: "Vue", value: 3 },
    { source: "Frontend", target: "Solid", value: 3 },
    { source: "Frontend", target: "Svelte", value: 3 },
    { source: "Frontend", target: "Angular", value: 3 },

    // Backend -> runtimes
    { source: "Backend", target: "Node.js", value: 3 },
    { source: "Backend", target: "Deno", value: 3 },
    { source: "Backend", target: "Go", value: 3 },
    { source: "Backend", target: "Rust", value: 3 },
    { source: "Backend", target: "Python", value: 3 },

    // Database -> databases
    { source: "Database", target: "PostgreSQL", value: 3 },
    { source: "Database", target: "MongoDB", value: 3 },
    { source: "Database", target: "Redis", value: 3 },
    { source: "Database", target: "SQLite", value: 3 },

    // DevOps -> tools
    { source: "DevOps", target: "Docker", value: 3 },
    { source: "DevOps", target: "K8s", value: 3 },
    { source: "DevOps", target: "GitHub Actions", value: 3 },
    { source: "DevOps", target: "Terraform", value: 3 },

    // Mobile -> platforms
    { source: "Mobile", target: "React Native", value: 3 },
    { source: "Mobile", target: "Flutter", value: 3 },
    { source: "Mobile", target: "Swift", value: 3 },
    { source: "Mobile", target: "Kotlin", value: 3 },

    // React -> meta-frameworks
    { source: "React", target: "Next.js", value: 2 },
    { source: "React", target: "Remix", value: 2 },
    { source: "React", target: "Gatsby", value: 2 },

    // Vue -> meta-frameworks
    { source: "Vue", target: "Nuxt", value: 2 },
    { source: "Vue", target: "Vite", value: 2 },

    // Solid -> meta-frameworks
    { source: "Solid", target: "SolidStart", value: 2 },

    // Svelte -> meta-frameworks
    { source: "Svelte", target: "SvelteKit", value: 2 },

    // Node.js -> frameworks
    { source: "Node.js", target: "Express", value: 2 },
    { source: "Node.js", target: "Fastify", value: 2 },
    { source: "Node.js", target: "NestJS", value: 2 },

    // Deno -> frameworks
    { source: "Deno", target: "Fresh", value: 2 },
    { source: "Deno", target: "Hono", value: 2 },
    { source: "Deno", target: "Oak", value: 2 },

    // Go -> frameworks
    { source: "Go", target: "Gin", value: 2 },
    { source: "Go", target: "Echo", value: 2 },

    // Python -> frameworks
    { source: "Python", target: "FastAPI", value: 2 },
    { source: "Python", target: "Django", value: 2 },
    { source: "Python", target: "Flask", value: 2 },

    // Rust -> frameworks
    { source: "Rust", target: "Actix", value: 2 },
    { source: "Rust", target: "Axum", value: 2 },
  ],
};

export interface ForceGraphProps {
  width?: number;
  height?: number;
  data?: GraphData;
}

export function ForceGraph(props: ForceGraphProps) {
  let svgRef: SVGSVGElement | undefined;

  const width = () => props.width ?? 800;
  const height = () => props.height ?? 600;

  onMount(() => {
    if (!svgRef) return;

    const data = props.data ?? sampleData;

    // Create copies of data
    const links: LinkDatum[] = data.links.map((d) => ({ ...d }));
    const nodes: NodeDatum[] = data.nodes.map((d) => ({ ...d }));

    // Create simulation with forces that keep nodes within bounds
    const simulation = d3
      .forceSimulation(nodes)
      .force(
        "link",
        d3
          .forceLink<NodeDatum, LinkDatum>(links)
          .id((d: NodeDatum) => d.id)
          .distance(40)
          .strength(1),
      )
      .force("charge", d3.forceManyBody().strength(-200))
      .force("x", d3.forceX().strength(0.1))
      .force("y", d3.forceY().strength(0.1))
      .force("collision", d3.forceCollide().radius(5));

    // Create SVG
    const svg = d3
      .select(svgRef)
      .attr("viewBox", [-width() / 2, -height() / 2, width(), height()]);

    // Clear previous content
    svg.selectAll("*").remove();

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
      .attr("stroke-width", 0.5);

    // Add nodes (same size, same color)
    const node = g
      .append("g")
      .attr("stroke", "#fff")
      .attr("stroke-width", 0.5)
      .selectAll<SVGCircleElement, NodeDatum>("circle")
      .data(nodes)
      .join("circle")
      .attr("r", 2.5)
      .attr("fill", "#6366f1")
      .style("cursor", "grab");

    // Add titles for hover
    node.append("title").text((d: NodeDatum) => d.id);

    // Add drag behavior
    const drag = d3
      .drag<SVGCircleElement, NodeDatum>()
      .on("start", dragstarted)
      .on("drag", dragged)
      .on("end", dragended);

    function dragstarted(
      event: d3.D3DragEvent<SVGCircleElement, NodeDatum, NodeDatum>,
      d: NodeDatum,
    ) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
    }

    function dragged(
      event: d3.D3DragEvent<SVGCircleElement, NodeDatum, NodeDatum>,
      d: NodeDatum,
    ) {
      d.fx = event.x;
      d.fy = event.y;
    }

    function dragended(
      event: d3.D3DragEvent<SVGCircleElement, NodeDatum, NodeDatum>,
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

      node
        .attr("cx", (d: NodeDatum) => d.x ?? 0)
        .attr("cy", (d: NodeDatum) => d.y ?? 0);
    });

    onCleanup(() => {
      simulation.stop();
    });
  });

  return <svg ref={svgRef} class="w-full h-full touch-none" />;
}
