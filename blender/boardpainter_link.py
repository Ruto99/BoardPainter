# BoardPainter Link: send meshes between Blender and BoardPainter with one click (like GoZ).
#
# Install: Edit > Preferences > Add-ons > (menu) Install from Disk... > choose this file, then enable it.
# Use: 3D View > Sidebar (N) > BoardPainter tab.
#   "Send to BoardPainter"   the selected mesh objects go to BoardPainter (it picks them up while "Blender link" is on)
#   "Receive"                 parts BoardPainter sent are brought in; with "Auto receive" on, that happens by itself
# An object with the same name and the same vertex / face count is updated in place (modifiers, materials, UVs and
# the object's transform stay); anything else gets its mesh replaced, or a new object is made.
#
# Exchange folder: <home>/BoardPainterLink (to_blender, to_boardpainter), or the BP_LINK_DIR environment variable,
# or the folder set in this add-on's preferences. Files are OBJ text in BoardPainter's coordinates (Y up).

bl_info = {
    "name": "BoardPainter Link",
    "author": "BoardPainter",
    "version": (1, 0, 0),
    "blender": (3, 6, 0),
    "location": "3D View > Sidebar > BoardPainter",
    "description": "Send meshes to and from BoardPainter with one click (like GoZ)",
    "category": "Import-Export",
}

import os
import bpy
from mathutils import Matrix, Vector

# BoardPainter is Y up, Blender is Z up: BP (x, y, z) = Blender (x, z, -y)
def bp_to_bl(x, y, z):
    return (x, -z, y)

def bl_to_bp(x, y, z):
    return (x, z, -y)


def link_root():
    try:
        prefs = bpy.context.preferences.addons[__name__].preferences
        if prefs.folder:
            return bpy.path.abspath(prefs.folder)
    except (KeyError, AttributeError):
        pass
    return os.environ.get("BP_LINK_DIR") or os.path.join(os.path.expanduser("~"), "BoardPainterLink")


def link_dir(sub):
    d = os.path.join(link_root(), sub)
    os.makedirs(d, exist_ok=True)
    return d


def safe_name(n):
    return "".join("_" if c in '\\/:*?"<>|' or ord(c) < 32 else c for c in n)[:120] or "part"


# ---------------- OBJ text ----------------
def write_obj(obj, path):
    """World-space positions of the object's own mesh (no modifiers), polygons, and point colors if it has them."""
    me = obj.data
    mw = obj.matrix_world
    n = len(me.vertices)
    co = [0.0] * (n * 3)
    me.vertices.foreach_get("co", co)
    col = None
    attr = me.color_attributes.active_color if hasattr(me, "color_attributes") else None
    if attr is not None and attr.domain == 'POINT' and len(attr.data) == n:
        col = [0.0] * (n * 4)
        attr.data.foreach_get("color", col)
    out = ["# BoardPainter link 1", "o " + obj.name]
    for i in range(n):
        p = mw @ Vector((co[i * 3], co[i * 3 + 1], co[i * 3 + 2]))
        x, y, z = bl_to_bp(p.x, p.y, p.z)
        if col:
            out.append("v %.7g %.7g %.7g %.5g %.5g %.5g" % (x, y, z, col[i * 4], col[i * 4 + 1], col[i * 4 + 2]))
        else:
            out.append("v %.7g %.7g %.7g" % (x, y, z))
    # a negative scale flips the winding
    flip = mw.determinant() < 0
    for poly in me.polygons:
        vs = [v + 1 for v in poly.vertices]
        if flip:
            vs.reverse()
        out.append("f " + " ".join(map(str, vs)))
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    os.replace(tmp, path)


def read_obj(path):
    name, pos, col, uv, faces, fuv = None, [], [], [], [], []
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("v "):
                p = line.split()
                pos.append(bp_to_bl(float(p[1]), float(p[2]), float(p[3])))
                if len(p) >= 7:
                    col.append((float(p[4]), float(p[5]), float(p[6]), 1.0))
            elif line.startswith("vt "):
                p = line.split()
                uv.append((float(p[1]), float(p[2])))
            elif line.startswith("f "):
                vs, ts = [], []
                for t in line.split()[1:]:
                    a = t.split("/")
                    vs.append(int(a[0]) - 1)
                    ts.append(int(a[1]) - 1 if len(a) > 1 and a[1] else -1)
                faces.append(vs)
                fuv.append(ts)
            elif line.startswith("o "):
                name = line[2:].strip()
    if not name:
        name = os.path.splitext(os.path.basename(path))[0]
    if len(col) != len(pos):
        col = []
    return name, pos, col, uv, faces, fuv


def build_mesh(name, pos, col, uv, faces, fuv):
    me = bpy.data.meshes.new(name)
    me.vertices.add(len(pos))
    me.vertices.foreach_set("co", [c for p in pos for c in p])
    loops = [v for f in faces for v in f]
    me.loops.add(len(loops))
    me.loops.foreach_set("vertex_index", loops)
    me.polygons.add(len(faces))
    starts, s = [], 0
    for f in faces:
        starts.append(s)
        s += len(f)
    me.polygons.foreach_set("loop_start", starts)
    try:
        me.polygons.foreach_set("loop_total", [len(f) for f in faces])
    except (AttributeError, TypeError, RuntimeError):
        pass   # Blender 4+ derives the sizes from loop_start
    if uv and all(t >= 0 for ts in fuv for t in ts):
        layer = me.uv_layers.new(name="UVMap")
        layer.data.foreach_set("uv", [c for ts in fuv for t in ts for c in uv[t]])
    if col:
        attr = me.color_attributes.new("Color", 'FLOAT_COLOR', 'POINT')
        attr.data.foreach_set("color", [c for p in col for c in p])
    me.update(calc_edges=True)
    me.validate()
    return me


def receive_all(context):
    d = link_dir("to_blender")
    names = sorted(f for f in os.listdir(d) if f.lower().endswith(".obj"))
    done = []
    for fn in names:
        path = os.path.join(d, fn)
        try:
            name, pos, col, uv, faces, fuv = read_obj(path)
        except (OSError, ValueError, IndexError):
            continue
        obj = bpy.data.objects.get(name)
        if obj is not None and obj.type == 'MESH' and len(obj.data.vertices) == len(pos) and len(obj.data.polygons) == len(faces):
            # same topology: move the vertices only (world -> the object's local space)
            inv = obj.matrix_world.inverted()
            flat = []
            for p in pos:
                q = inv @ Vector(p)
                flat.extend((q.x, q.y, q.z))
            obj.data.vertices.foreach_set("co", flat)
            if col:
                attr = obj.data.color_attributes.get("Color")
                if attr is not None and attr.domain == 'POINT':
                    attr.data.foreach_set("color", [c for p in col for c in p])
            obj.data.update()
            how = "updated"
        else:
            me = build_mesh(name, pos, col, uv, faces, fuv)
            if obj is not None and obj.type == 'MESH':
                old = obj.data
                me.transform(obj.matrix_world.inverted())
                for m in old.materials:
                    me.materials.append(m)
                obj.data = me
                if old.users == 0:
                    bpy.data.meshes.remove(old)
                how = "replaced"
            else:
                obj = bpy.data.objects.new(name, me)
                context.scene.collection.objects.link(obj)
                how = "new"
        try:
            os.remove(path)
        except OSError:
            pass
        done.append((name, how))
    return done


# ---------------- UI ----------------
class BPLINK_OT_send(bpy.types.Operator):
    bl_idname = "bplink.send"
    bl_label = "BoardPainter へ送る"
    bl_description = "選択中のメッシュを BoardPainter へ送ります"

    def execute(self, context):
        objs = [o for o in context.selected_objects if o.type == 'MESH']
        if not objs:
            self.report({'WARNING'}, "メッシュのオブジェクトを選んでください")
            return {'CANCELLED'}
        d = link_dir("to_boardpainter")
        for o in objs:
            write_obj(o, os.path.join(d, safe_name(o.name) + ".obj"))
        self.report({'INFO'}, "%d 個を BoardPainter へ送りました" % len(objs))
        return {'FINISHED'}


class BPLINK_OT_receive(bpy.types.Operator):
    bl_idname = "bplink.receive"
    bl_label = "BoardPainter から受け取る"
    bl_description = "BoardPainter から送られたパーツを読み込みます"

    def execute(self, context):
        done = receive_all(context)
        self.report({'INFO'}, "%d 個受け取りました" % len(done) if done else "受け取るものはありません")
        return {'FINISHED'}


def _auto_tick():
    wm = bpy.context.window_manager
    if not getattr(wm, "bplink_auto", False):
        return None
    try:
        receive_all(bpy.context)
    except Exception as err:   # keep the timer alive
        print("BoardPainter Link:", err)
    return 1.0


def _auto_update(self, context):
    if self.bplink_auto and not bpy.app.timers.is_registered(_auto_tick):
        bpy.app.timers.register(_auto_tick, first_interval=0.5)


class BPLINK_PT_panel(bpy.types.Panel):
    bl_label = "BoardPainter"
    bl_space_type = 'VIEW_3D'
    bl_region_type = 'UI'
    bl_category = "BoardPainter"

    def draw(self, context):
        col = self.layout.column(align=True)
        col.operator("bplink.send", icon='EXPORT')
        col.operator("bplink.receive", icon='IMPORT')
        self.layout.prop(context.window_manager, "bplink_auto")
        self.layout.label(text=link_root())


class BPLINK_Prefs(bpy.types.AddonPreferences):
    bl_idname = __name__
    folder: bpy.props.StringProperty(name="受け渡しフォルダー", subtype='DIR_PATH', default="",
                                     description="空欄ならホームの BoardPainterLink フォルダー")

    def draw(self, context):
        self.layout.prop(self, "folder")


CLASSES = (BPLINK_OT_send, BPLINK_OT_receive, BPLINK_PT_panel, BPLINK_Prefs)


def register():
    for c in CLASSES:
        bpy.utils.register_class(c)
    bpy.types.WindowManager.bplink_auto = bpy.props.BoolProperty(
        name="自動で受け取る", description="BoardPainter から送られたら、すぐに読み込みます", default=False, update=_auto_update)


def unregister():
    if bpy.app.timers.is_registered(_auto_tick):
        bpy.app.timers.unregister(_auto_tick)
    del bpy.types.WindowManager.bplink_auto
    for c in reversed(CLASSES):
        bpy.utils.unregister_class(c)


if __name__ == "__main__":
    register()
