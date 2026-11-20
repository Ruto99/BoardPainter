// The tools BoardPainter offers to Claude over MCP (Model Context Protocol). The definitions here are what the
// model sees; the work is done in the page (agentCall in src/index.html), reached through the local bridge.
const vec3 = d => ({ type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3, description: d });
const select = {
  type: 'object', additionalProperties: false,
  description: 'Which faces. Omit (or {"all": true}) for every face. "normal" picks faces facing that way (within max_angle degrees); "min"/"max" keep faces whose centre lies inside that box. Combine as needed.',
  properties: {
    all: { type: 'boolean' },
    normal: vec3('Direction the faces should face, e.g. [0,1,0] for the top'),
    max_angle: { type: 'number', description: 'Degrees from "normal" (default 20)' },
    min: vec3('Lower corner of a box the face centres must be in'),
    max: vec3('Upper corner of that box'),
  },
};
const name = { type: 'string', description: 'Part name' };

module.exports = [
  { name: 'scene_info', description: 'List the parts in the scene: name, size, bounds, face / triangle / vertex counts, colour, subdivision levels. Coordinates: Y is up, the front faces +Z, 1 unit = 1 metre.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'new_scene', description: 'Start an empty scene (all current parts are removed once the first new shape is added). Undo restores them.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  {
    name: 'add_shape',
    description: 'Add a primitive part made of quads, centred on "position". box: size [w,h,d], optional segments [x,y,z] and taper (top face scale; 0.6 gives a frustum). cylinder / cone: radius, height, sides, rings (height segments), radius_top (cone: 0). sphere: radius, sides, rings. torus: radius (ring), tube_radius, sides, rings; the ring lies flat in the XZ plane. Rotation is in degrees, applied X, then Y, then Z.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['shape', 'name'],
      properties: {
        shape: { type: 'string', enum: ['box', 'cylinder', 'cone', 'sphere', 'torus'] },
        name,
        size: vec3('box: width (X), height (Y), depth (Z)'),
        segments: vec3('box: subdivisions along X, Y, Z (default 1,1,1)'),
        taper: { type: 'number', description: 'box: scale of the top face (default 1)' },
        radius: { type: 'number' }, radius_top: { type: 'number' }, height: { type: 'number' },
        tube_radius: { type: 'number' }, sides: { type: 'integer' }, rings: { type: 'integer' },
        position: vec3('Centre (default 0,0,0)'), rotation: vec3('Degrees about X, Y, Z'),
        color: { type: 'string', description: 'Colour as #rrggbb' },
      },
    },
  },
  {
    name: 'transform_part',
    description: 'Move, rotate (degrees X, Y, Z) and/or scale a part. Rotation and scale are about the part\'s centre unless "pivot" is given.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name, move: vec3('Offset'), rotate: vec3('Degrees'), scale: { description: 'Number or [x,y,z]', oneOf: [{ type: 'number' }, vec3('')] }, pivot: vec3('Point to rotate / scale about') } },
  },
  {
    name: 'duplicate_part',
    description: 'Copy a part under a new name, optionally mirrored across X = 0 and/or moved / rotated.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'new_name'], properties: { name, new_name: { type: 'string' }, mirror_x: { type: 'boolean' }, move: vec3('Offset'), rotate: vec3('Degrees about the copy\'s centre') } },
  },
  {
    name: 'set_part',
    description: 'Rename, recolour (#rrggbb, the whole part), show / hide, or delete a part.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name, new_name: { type: 'string' }, color: { type: 'string' }, visible: { type: 'boolean' }, delete: { type: 'boolean' } } },
  },
  {
    name: 'edit_faces',
    description: 'Polygon modelling on a part (before it is subdivided). extrude: push the selected faces out along their normals by "amount" (negative = in); each connected patch moves as one. inset: shrink each connected patch inward by "amount" (0..0.95 of its size) leaving a border ring of faces. delete: remove the faces (leaves a hole). paint: colour the faces with "color". Use individual: true to treat every face on its own.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'action'], properties: { name, action: { type: 'string', enum: ['extrude', 'inset', 'delete', 'paint'] }, amount: { type: 'number' }, color: { type: 'string' }, individual: { type: 'boolean' }, select } },
  },
  {
    name: 'bevel_edges',
    description: 'Chamfer every sharp edge (faces meeting at more than min_angle degrees, default 40) of a part. width is a fraction of the neighbouring edges (0.02..0.45, default 0.12).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name, width: { type: 'number' }, min_angle: { type: 'number' } } },
  },
  {
    name: 'insert_loops',
    description: 'Add evenly spaced edge loops to a part, cutting across the edges that run along "axis" (e.g. axis "y" on a cylinder adds horizontal rings). Useful before deform.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'axis'], properties: { name, axis: { type: 'string', enum: ['x', 'y', 'z'] }, count: { type: 'integer', description: '1..9 (default 3)' } } },
  },
  {
    name: 'deform',
    description: 'Bend the shape of a part along an axis through its centre. taper: the far end (max side of the axis) scales by (1 + amount), the near end stays. bulge: the middle swells by amount (0.15 = 15%), the ends stay (barrels, vases). twist: amount degrees from end to end. bend: amount degrees, bending toward +"toward" axis. Needs enough loops along the axis to look smooth (see insert_loops).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'type', 'axis', 'amount'], properties: { name, type: { type: 'string', enum: ['taper', 'bulge', 'twist', 'bend'] }, axis: { type: 'string', enum: ['x', 'y', 'z'] }, toward: { type: 'string', enum: ['x', 'y', 'z'] }, amount: { type: 'number' } } },
  },
  {
    name: 'boolean',
    description: 'Exact boolean of two closed parts: the "target" part is replaced by target union / minus / intersect "tool"; the tool part is hidden (or deleted with delete_tool). Sharp edges stay exact; the cut is tidied so it can be edited further.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['target', 'tool', 'op'], properties: { target: { type: 'string' }, tool: { type: 'string' }, op: { type: 'string', enum: ['union', 'subtract', 'intersect'] }, delete_tool: { type: 'boolean' } } },
  },
  {
    name: 'combine_parts',
    description: 'Join several parts into one part (no boolean: the pieces just become one mesh). Colours are kept.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['names', 'new_name'], properties: { names: { type: 'array', items: { type: 'string' }, minItems: 2 }, new_name: { type: 'string' } } },
  },
  {
    name: 'subdivide',
    description: 'Smooth a part by subdividing it (Catmull-Clark for quads) "levels" times (1..3). With keep_sharp (default true) edges sharper than 40 degrees are creased first so they stay crisp. Do polygon edits before this.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name'], properties: { name, levels: { type: 'integer' }, keep_sharp: { type: 'boolean' } } },
  },
  {
    name: 'render',
    description: 'Look at the scene: returns PNG images of the visible parts from the given views (front, back, left, right, top, bottom, persp = front-right-above, persp_back). Use wireframe to see the polygon edges.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { views: { type: 'array', items: { type: 'string', enum: ['front', 'back', 'left', 'right', 'top', 'bottom', 'persp', 'persp_back'] } }, size: { type: 'integer', description: '128..1024 (default 384)' }, wireframe: { type: 'boolean' } } },
  },
  {
    name: 'export',
    description: 'Save the visible parts as a game asset file (glb, fbx or obj) in the BoardPainterLink/exports folder; returns the path.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['format', 'file_name'], properties: { format: { type: 'string', enum: ['glb', 'fbx', 'obj'] }, file_name: { type: 'string' } } },
  },
  { name: 'undo', description: 'Undo the last steps.', inputSchema: { type: 'object', additionalProperties: false, properties: { steps: { type: 'integer' } } } },
];
