/**
 * Programmatic SEO page definitions for TimrX.
 * Each entry generates a unique, Google-indexable landing page.
 */

export const SEO_PAGES = {
  // ─── /3d-models/:slug pages ───
  '3d-models': {
    base: '/3d-models',
    pages: [
      { slug: 'dragon', title: 'AI Dragon 3D Model Generator', h1: 'Create Dragon 3D Models with AI', desc: 'Generate stunning dragon 3D models from text prompts. Crystal dragons, fire drakes, wyverns — AI-powered text-to-3D creation ready for 3D printing and game engines.', prompt: 'Crystal dragon with iridescent scales perched on volcanic rock, fantasy art style', category: 'Fantasy', keywords: 'dragon 3D model, AI dragon generator, fantasy 3D model, dragon STL, dragon GLB' },
      { slug: 'robot', title: 'AI Robot 3D Model Generator', h1: 'Create Robot 3D Models with AI', desc: 'Generate detailed robot and mech 3D models from text descriptions. Humanoid robots, mechs, androids — export GLB/GLTF for printing or game development.', prompt: 'Futuristic humanoid robot with chrome armor plates and glowing blue joints', category: 'Sci-Fi', keywords: 'robot 3D model, AI robot generator, mech 3D model, robot STL' },
      { slug: 'character', title: 'AI Character 3D Model Generator', h1: 'Create Character 3D Models with AI', desc: 'Generate unique character 3D models — heroes, villains, NPCs, and figurines. AI-powered text-to-3D for game developers, tabletop gamers, and artists.', prompt: 'Fantasy warrior in ornate armor, holding a shield, heroic pose, tabletop miniature style', category: 'Characters', keywords: 'character 3D model, AI character creator, figurine generator, NPC 3D model' },
      { slug: 'vehicle', title: 'AI Vehicle 3D Model Generator', h1: 'Create Vehicle 3D Models with AI', desc: 'Generate cars, spaceships, tanks, and more as 3D models. AI text-to-3D vehicle creation with GLB export for games, animation, and 3D printing.', prompt: 'Retro 1960s racing car with chrome details, vintage red paint, low-poly style', category: 'Vehicles', keywords: 'vehicle 3D model, AI car generator, spaceship 3D model, vehicle GLB' },
      { slug: 'animal', title: 'AI Animal 3D Model Generator', h1: 'Create Animal 3D Models with AI', desc: 'Generate realistic and stylized animal 3D models. Dogs, cats, dinosaurs, mythical creatures — AI-powered creation ready for printing and rendering.', prompt: 'Majestic wolf howling at the moon, detailed fur texture, forest clearing', category: 'Nature', keywords: 'animal 3D model, AI animal generator, pet 3D model, dinosaur STL' },
      { slug: 'architecture', title: 'AI Architecture 3D Model Generator', h1: 'Create Architecture 3D Models with AI', desc: 'Generate buildings, temples, towers, and architectural structures as 3D models. AI text-to-3D for architects, game designers, and hobbyists.', prompt: 'Greek temple ruins with marble columns, overgrown vines, photorealistic weathering', category: 'Architecture', keywords: 'architecture 3D model, building generator, temple 3D model, house STL' },
      { slug: 'weapon', title: 'AI Weapon & Prop 3D Model Generator', h1: 'Create Weapon & Prop 3D Models with AI', desc: 'Generate swords, shields, staffs, sci-fi weapons, and game props as 3D models. AI-powered asset creation for game developers and cosplayers.', prompt: 'Enchanted sword with glowing blue runes embedded in a mossy stone altar, fantasy style', category: 'Fantasy', keywords: 'weapon 3D model, sword generator, prop 3D model, game asset GLB' },
      { slug: 'miniature', title: 'AI Miniature 3D Model Generator', h1: 'Create Tabletop Miniatures with AI', desc: 'Generate tabletop gaming miniatures, dioramas, and figurines. AI text-to-3D creation optimized for FDM and resin 3D printing.', prompt: 'Tabletop miniature wizard casting a spell, robes flowing, diorama base with runes', category: 'Characters', keywords: 'miniature 3D model, tabletop miniature generator, D&D miniature, wargaming STL' },
      { slug: 'furniture', title: 'AI Furniture 3D Model Generator', h1: 'Create Furniture 3D Models with AI', desc: 'Generate chairs, tables, shelves, and interior objects as 3D models. AI-powered design for interior visualisation and product prototyping.', prompt: 'Mid-century modern lounge chair, walnut wood frame, leather cushion, studio lighting', category: 'Architecture', keywords: 'furniture 3D model, chair generator, interior design 3D, product prototype' },
      { slug: 'spaceship', title: 'AI Spaceship 3D Model Generator', h1: 'Create Spaceship 3D Models with AI', desc: 'Generate spaceships, starfighters, and sci-fi vessels as 3D models. AI text-to-3D for game devs, filmmakers, and sci-fi enthusiasts.', prompt: 'Sleek interstellar cruiser with ion engines, modular hull panels, deep space backdrop', category: 'Sci-Fi', keywords: 'spaceship 3D model, AI spaceship generator, starship GLB, sci-fi vehicle STL' },
    ]
  },

  // ─── /text-to-3d/:slug pages ───
  'text-to-3d': {
    base: '/text-to-3d',
    pages: [
      { slug: 'dragon', title: 'Text to 3D Dragon — AI Generator', h1: 'Turn Text Into a 3D Dragon', desc: 'Type a description and get a detailed dragon 3D model. AI text-to-3D generation with GLB export for printing, games, and rendering.', prompt: 'A fearsome dragon with polished obsidian scales, glowing red eyes, dark fantasy style', category: 'Fantasy', keywords: 'text to 3D dragon, AI dragon, generate dragon model' },
      { slug: 'robot', title: 'Text to 3D Robot — AI Generator', h1: 'Turn Text Into a 3D Robot', desc: 'Describe a robot and get a 3D model in minutes. AI-powered text-to-3D creation with full export support.', prompt: 'Bipedal patrol robot with sensor dome head, matte olive panels, utility belt', category: 'Sci-Fi', keywords: 'text to 3D robot, AI robot model, generate robot 3D' },
      { slug: 'house', title: 'Text to 3D House — AI Generator', h1: 'Turn Text Into a 3D House', desc: 'Describe any building and AI generates a 3D model. Houses, castles, cabins — export GLB for visualisation or printing.', prompt: 'Cozy forest cabin with stone chimney, snow on roof, warm light from windows', category: 'Architecture', keywords: 'text to 3D house, AI building model, generate house 3D' },
      { slug: 'sword', title: 'Text to 3D Sword — AI Generator', h1: 'Turn Text Into a 3D Sword', desc: 'Create custom sword and weapon 3D models from text. Fantasy blades, sci-fi weapons, historical arms — AI generation with GLB export.', prompt: 'Katana with black and gold tsuka wrapping, hamon line on blade, cherry blossom guard', category: 'Fantasy', keywords: 'text to 3D sword, AI weapon model, generate sword 3D' },
      { slug: 'car', title: 'Text to 3D Car — AI Generator', h1: 'Turn Text Into a 3D Car', desc: 'Describe any vehicle and get a 3D model. Classic cars, supercars, concept vehicles — AI text-to-3D with full export.', prompt: 'Matte black supercar with aggressive body kit, carbon fiber accents, studio lighting', category: 'Vehicles', keywords: 'text to 3D car, AI car model, generate car 3D' },
      { slug: 'tree', title: 'Text to 3D Tree — AI Generator', h1: 'Turn Text Into a 3D Tree', desc: 'Generate tree and plant 3D models from text descriptions. Bonsai, oak, fantasy trees — AI creation for games, scenes, and printing.', prompt: 'Ancient bonsai tree growing from a cracked geode crystal, roots wrapping around gems', category: 'Nature', keywords: 'text to 3D tree, AI tree model, generate plant 3D' },
      { slug: 'helmet', title: 'Text to 3D Helmet — AI Generator', h1: 'Turn Text Into a 3D Helmet', desc: 'Create custom helmet 3D models from text. Medieval, sci-fi, cosplay — AI generation optimized for 3D printing.', prompt: 'Spartan warrior helmet with bronze patina, red horsehair crest, battle-worn scratches', category: 'Characters', keywords: 'text to 3D helmet, AI helmet model, cosplay helmet 3D' },
      { slug: 'castle', title: 'Text to 3D Castle — AI Generator', h1: 'Turn Text Into a 3D Castle', desc: 'Describe a castle and get a detailed 3D model. Medieval fortresses, fantasy citadels, ruins — AI text-to-3D with GLB export.', prompt: 'Dark fantasy castle on cliff edge, gothic towers, stormy sky, ravens circling', category: 'Architecture', keywords: 'text to 3D castle, AI castle model, generate castle 3D' },
    ]
  }
};

/**
 * Flat lookup: returns page data for a given path like /3d-models/dragon
 */
export function findSeoPage(pathname) {
  for (const [groupKey, group] of Object.entries(SEO_PAGES)) {
    for (const page of group.pages) {
      if (pathname === `${group.base}/${page.slug}`) {
        return { ...page, group: groupKey, basePath: group.base };
      }
    }
  }
  return null;
}

/**
 * Generate sitemap XML entries for all SEO pages
 */
export function generateSeoSitemap() {
  const entries = [];
  for (const [, group] of Object.entries(SEO_PAGES)) {
    for (const page of group.pages) {
      entries.push(`  <url>
    <loc>https://timrx.live${group.base}/${page.slug}</loc>
    <lastmod>${new Date().toISOString().split('T')[0]}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
  </url>`);
    }
  }
  return entries.join('\n');
}
