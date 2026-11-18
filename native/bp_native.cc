// BoardPainter native module (Node-API, so one build works across Electron versions).
// Heavy, self-contained mesh kernels ported from src/remesh.js. They produce the same results as the
// JavaScript versions (same arithmetic, same float32 rounding) but run in C++ on all CPU cores.
//
//   voxelize(pos: Float32Array, idx: Uint32Array, o: number[3], n: number[3], h: number) -> Uint8Array
//   surfaceNets(inside: Uint8Array, o: number[3], n: number[3], h: number) -> { pos, idx, quads }
//   fitSurface(pos, idx, srcPos, srcIdx, buried: Uint8Array|null, maxSnap, smooth, project) -> { pos, face, bary }
//   info() -> { version, threads }
#define NAPI_VERSION 8
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <numeric>
#include <thread>
#include <vector>

namespace {

const char* kVersion = "1.1.0";

unsigned hwThreads() {
  unsigned t = std::thread::hardware_concurrency();
  return t ? std::min(t, 64u) : 4u;
}

// Run fn(i) for i in [0, count) on up to `threads` threads (work stealing by an atomic counter).
template <class F>
void parallelFor(size_t count, unsigned threads, F fn) {
  if (count == 0) return;
  threads = std::max(1u, std::min<unsigned>(threads, (unsigned)std::min<size_t>(count, 1u << 20)));
  if (threads == 1) { for (size_t i = 0; i < count; i++) fn(i); return; }
  std::atomic<size_t> next{0};
  const size_t chunk = std::max<size_t>(1, count / (threads * 16));
  auto work = [&]() {
    for (;;) {
      size_t s = next.fetch_add(chunk);
      if (s >= count) break;
      size_t e = std::min(count, s + chunk);
      for (size_t i = s; i < e; i++) fn(i);
    }
  };
  std::vector<std::thread> pool;
  for (unsigned t = 1; t < threads; t++) pool.emplace_back(work);
  work();
  for (auto& th : pool) th.join();
}

struct Grid { double h; double o[3]; int64_t n[3]; };

// ---------------- voxelize: winding numbers along one axis (see windingAlongAxis in remesh.js) ----------------
void windingAlongAxis(const float* pos, const uint32_t* idx, size_t nF, const Grid& G, int a, uint8_t* votes, unsigned threads) {
  const int u = (a + 1) % 3, v = (a + 2) % 3;
  const int64_t nu = G.n[u], nv = G.n[v], na = G.n[a];
  const double h = G.h, ou = G.o[u], ov = G.o[v], oa = G.o[a];
  const double ju = 0.000137, jv = 0.000291;
  const size_t cols = (size_t)(nu * nv);
  std::vector<uint32_t> count(cols + 1, 0);

  auto forEachHit = [&](auto cb) {
    for (size_t f = 0; f < nF; f++) {
      const size_t A = (size_t)idx[f*3] * 3, B = (size_t)idx[f*3+1] * 3, C = (size_t)idx[f*3+2] * 3;
      const double au = pos[A+u], av = pos[A+v], bu = pos[B+u], bv = pos[B+v], cu = pos[C+u], cv = pos[C+v];
      const double det = (bu - au) * (cv - av) - (cu - au) * (bv - av);
      if (det == 0) continue;
      const int64_t i0 = std::max<int64_t>(0, (int64_t)std::ceil((std::min({au, bu, cu}) - ou) / h - ju));
      const int64_t i1 = std::min<int64_t>(nu - 1, (int64_t)std::floor((std::max({au, bu, cu}) - ou) / h - ju));
      const int64_t j0 = std::max<int64_t>(0, (int64_t)std::ceil((std::min({av, bv, cv}) - ov) / h - jv));
      const int64_t j1 = std::min<int64_t>(nv - 1, (int64_t)std::floor((std::max({av, bv, cv}) - ov) / h - jv));
      if (i0 > i1 || j0 > j1) continue;
      const int8_t s = det > 0 ? 1 : -1;
      for (int64_t j = j0; j <= j1; j++) {
        const double pv = ov + (j + jv) * h;
        for (int64_t i = i0; i <= i1; i++) {
          const double pu = ou + (i + ju) * h;
          const double w1 = ((pu - au) * (cv - av) - (cu - au) * (pv - av)) / det;
          const double w2 = ((bu - au) * (pv - av) - (pu - au) * (bv - av)) / det;
          if (w1 < 0 || w2 < 0 || w1 + w2 > 1) continue;
          cb((size_t)(i + nu * j), pos[A+a] + (pos[B+a] - pos[A+a]) * w1 + (pos[C+a] - pos[A+a]) * w2, s);
        }
      }
    }
  };
  forEachHit([&](size_t c, double, int8_t) { count[c + 1]++; });
  for (size_t c = 0; c < cols; c++) count[c + 1] += count[c];
  std::vector<float> depth(count[cols]);
  std::vector<int8_t> sign(count[cols]);
  std::vector<uint32_t> fill(count.begin(), count.end() - 1);
  forEachHit([&](size_t c, double t, int8_t s) { const uint32_t k = fill[c]++; depth[k] = (float)t; sign[k] = s; });

  const int64_t stride[3] = {1, G.n[0], G.n[0] * G.n[1]};
  const int64_t strideA = stride[a], strideU = stride[u], strideV = stride[v];
  // columns are independent: each grid point belongs to exactly one column of this axis
  parallelFor(cols, threads, [&](size_t c) {
    const uint32_t s0 = count[c], s1 = count[c + 1];
    if (s0 == s1) return;
    const int64_t i = (int64_t)(c % nu), j = (int64_t)(c / nu);
    thread_local std::vector<uint32_t> order;
    order.resize(s1 - s0);
    std::iota(order.begin(), order.end(), s0);
    std::stable_sort(order.begin(), order.end(), [&](uint32_t p, uint32_t q) { return depth[p] < depth[q]; });
    int w = 0; size_t m = 0;
    const int64_t base = i * strideU + j * strideV;
    for (int64_t k = 0; k < na; k++) {
      const double t = oa + k * h;
      while (m < order.size() && depth[order[m]] < t) { w += sign[order[m]]; m++; }
      if (w != 0) votes[base + k * strideA]++;
    }
  });
}

// ---------------- surface nets (see surfaceNets in remesh.js) ----------------
struct NetOut { std::vector<double> P; std::vector<uint32_t> I, Q; };

void surfaceNets(const uint8_t* inside, const Grid& G, NetOut& out) {
  const int64_t nx = G.n[0], ny = G.n[1], nz = G.n[2];
  const int64_t sx = 1, sy = nx, sz = nx * ny;
  const double h = G.h, ox = G.o[0], oy = G.o[1], oz = G.o[2];
  std::vector<int32_t> cellV((size_t)(nx * ny * nz), -1);
  static const int corner[8][3] = {{0,0,0},{1,0,0},{0,1,0},{1,1,0},{0,0,1},{1,0,1},{0,1,1},{1,1,1}};
  static const int edges[12][2] = {{0,1},{2,3},{4,5},{6,7},{0,2},{1,3},{4,6},{5,7},{0,4},{1,5},{2,6},{3,7}};
  auto& P = out.P;
  uint8_t val[8];
  for (int64_t k = 0; k < nz - 1; k++) for (int64_t j = 0; j < ny - 1; j++) for (int64_t i = 0; i < nx - 1; i++) {
    const int64_t g = i + j * sy + k * sz;
    int m = 0;
    for (int c = 0; c < 8; c++) { val[c] = inside[g + corner[c][0] * sx + corner[c][1] * sy + corner[c][2] * sz]; m |= val[c] << c; }
    if (m == 0 || m == 255) continue;
    double px = 0, py = 0, pz = 0; int cnt = 0;
    for (const auto& e : edges) if (val[e[0]] != val[e[1]]) {
      px += (corner[e[0]][0] + corner[e[1]][0]) / 2.0; py += (corner[e[0]][1] + corner[e[1]][1]) / 2.0; pz += (corner[e[0]][2] + corner[e[1]][2]) / 2.0; cnt++;
    }
    cellV[g] = (int32_t)(P.size() / 3);
    P.push_back(ox + (i + px / cnt) * h); P.push_back(oy + (j + py / cnt) * h); P.push_back(oz + (k + pz / cnt) * h);
  }
  auto d2 = [&](uint32_t a, uint32_t b) {
    const double x = P[a*3] - P[b*3], y = P[a*3+1] - P[b*3+1], z = P[a*3+2] - P[b*3+2];
    return x * x + y * y + z * z;
  };
  auto quad = [&](uint32_t a, uint32_t b, uint32_t c, uint32_t d) {
    out.Q.insert(out.Q.end(), {a, b, c, d});
    if (d2(a, c) <= d2(b, d)) out.I.insert(out.I.end(), {a, b, c, a, c, d});
    else out.I.insert(out.I.end(), {a, b, d, b, c, d});
  };
  const int64_t S[3] = {sx, sy, sz};
  for (int64_t k = 1; k < nz - 1; k++) for (int64_t j = 1; j < ny - 1; j++) for (int64_t i = 1; i < nx - 1; i++) {
    const int64_t g = i + j * sy + k * sz; const uint8_t here = inside[g];
    for (int d = 0; d < 3; d++) {
      if (here == inside[g + S[d]]) continue;
      const int64_t du = S[(d + 1) % 3], dv = S[(d + 2) % 3];
      const int32_t c0 = cellV[g - du - dv], c1 = cellV[g - dv], c2 = cellV[g], c3 = cellV[g - du];
      if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) continue;
      if (here) quad(c0, c1, c2, c3); else quad(c0, c3, c2, c1);
    }
  }
}

// ---------------- closest point on a triangle mesh (AABB tree) ----------------
struct V3 { double x, y, z; };
inline V3 operator-(V3 a, V3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
inline V3 operator+(V3 a, V3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
inline V3 operator*(V3 a, double s) { return {a.x * s, a.y * s, a.z * s}; }
inline double dot(V3 a, V3 b) { return a.x * b.x + a.y * b.y + a.z * b.z; }

// Ericson, Real-Time Collision Detection 5.1.5; also returns barycentric weights of a, b, c
V3 closestOnTri(V3 p, V3 a, V3 b, V3 c, double bc[3]) {
  V3 ab = b - a, ac = c - a, ap = p - a;
  double d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) { bc[0] = 1; bc[1] = bc[2] = 0; return a; }
  V3 bp = p - b; double d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) { bc[1] = 1; bc[0] = bc[2] = 0; return b; }
  double vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { double v = d1 / (d1 - d3); bc[0] = 1 - v; bc[1] = v; bc[2] = 0; return a + ab * v; }
  V3 cp = p - c; double d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) { bc[2] = 1; bc[0] = bc[1] = 0; return c; }
  double vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { double w = d2 / (d2 - d6); bc[0] = 1 - w; bc[2] = w; bc[1] = 0; return a + ac * w; }
  double va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) { double w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); bc[1] = 1 - w; bc[2] = w; bc[0] = 0; return b + (c - b) * w; }
  double den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
  bc[0] = 1 - v - w; bc[1] = v; bc[2] = w;
  return a + ab * v + ac * w;
}

class TriTree {
 public:
  TriTree(const float* pos, const uint32_t* idx, size_t nF) : pos_(pos), idx_(idx) {
    tris_.resize(nF); std::iota(tris_.begin(), tris_.end(), 0u);
    cen_.resize(nF * 3);
    for (size_t f = 0; f < nF; f++) for (int k = 0; k < 3; k++)
      cen_[f*3+k] = (pos[idx[f*3]*3+k] + pos[idx[f*3+1]*3+k] + pos[idx[f*3+2]*3+k]) / 3.0f;
    nodes_.reserve(nF / 2 + 16);
    if (nF) { nodes_.push_back({}); build(0, 0, (uint32_t)nF); }
  }
  // closest point within sqrt(maxD2); returns face or -1
  int64_t closest(V3 p, double maxD2, V3& best, double bc[3]) const {
    if (nodes_.empty()) return -1;
    int64_t face = -1; double bestD2 = maxD2;
    uint32_t stack[128]; int sp = 0; stack[sp++] = 0;
    while (sp) {
      const Node& n = nodes_[stack[--sp]];
      if (boxD2(n, p) >= bestD2) continue;
      if (n.count) {
        for (uint32_t t = n.start; t < n.start + n.count; t++) {
          const uint32_t f = tris_[t]; double w[3];
          V3 q = closestOnTri(p, vtx(idx_[f*3]), vtx(idx_[f*3+1]), vtx(idx_[f*3+2]), w);
          V3 d = q - p; double d2 = dot(d, d);
          if (d2 < bestD2) { bestD2 = d2; best = q; face = f; bc[0] = w[0]; bc[1] = w[1]; bc[2] = w[2]; }
        }
      } else {
        const uint32_t l = n.left, r = n.left + 1;
        const double dl = boxD2(nodes_[l], p), dr = boxD2(nodes_[r], p);
        if (sp + 2 > 128) continue;
        if (dl < dr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
      }
    }
    return face;
  }

 private:
  struct Node { float mn[3], mx[3]; uint32_t left, start, count; };
  const float* pos_; const uint32_t* idx_;
  std::vector<uint32_t> tris_; std::vector<float> cen_; std::vector<Node> nodes_;
  V3 vtx(uint32_t v) const { return {pos_[v*3], pos_[v*3+1], pos_[v*3+2]}; }
  static double boxD2(const Node& n, V3 p) {
    double d = 0, c[3] = {p.x, p.y, p.z};
    for (int k = 0; k < 3; k++) { double e = c[k] < n.mn[k] ? n.mn[k] - c[k] : c[k] > n.mx[k] ? c[k] - n.mx[k] : 0; d += e * e; }
    return d;
  }
  void build(uint32_t slot, uint32_t s, uint32_t e) {
    Node n; for (int k = 0; k < 3; k++) { n.mn[k] = INFINITY; n.mx[k] = -INFINITY; }
    float cmn[3] = {INFINITY, INFINITY, INFINITY}, cmx[3] = {-INFINITY, -INFINITY, -INFINITY};
    for (uint32_t t = s; t < e; t++) {
      const uint32_t f = tris_[t];
      for (int c = 0; c < 3; c++) for (int k = 0; k < 3; k++) { float v = pos_[idx_[f*3+c]*3+k]; n.mn[k] = std::min(n.mn[k], v); n.mx[k] = std::max(n.mx[k], v); }
      for (int k = 0; k < 3; k++) { cmn[k] = std::min(cmn[k], cen_[f*3+k]); cmx[k] = std::max(cmx[k], cen_[f*3+k]); }
    }
    if (e - s <= 4) { n.left = 0; n.start = s; n.count = e - s; nodes_[slot] = n; return; }
    int ax = 0; for (int k = 1; k < 3; k++) if (cmx[k] - cmn[k] > cmx[ax] - cmn[ax]) ax = k;
    const uint32_t mid = s + (e - s) / 2;
    std::nth_element(tris_.begin() + s, tris_.begin() + mid, tris_.begin() + e, [&](uint32_t a, uint32_t b) { return cen_[a*3+ax] < cen_[b*3+ax]; });
    n.count = 0; n.start = 0; n.left = (uint32_t)nodes_.size();
    nodes_[slot] = n;
    nodes_.push_back({}); nodes_.push_back({});   // children are a consecutive pair
    build(n.left, s, mid); build(n.left + 1, mid, e);
  }
};

// Fit a remeshed surface to its source (see surfaceFromField in remesh.js):
// snap to the closest source face (unless it is buried), then `smooth` rounds of tangential relaxation + snap.
// Also returns, for every vertex, the closest source face and barycentric weights (for mask / colour transfer).
napi_value FitSurface(napi_env env, napi_callback_info info);

// ---------------- Node-API glue ----------------
#define CHECK(call) do { if ((call) != napi_ok) { napi_throw_error(env, nullptr, "bp_native: " #call); return nullptr; } } while (0)

bool typedArg(napi_env env, napi_value v, napi_typedarray_type want, void** data, size_t* len) {
  bool is = false; napi_is_typedarray(env, v, &is); if (!is) return false;
  napi_typedarray_type t; napi_value ab; size_t off;
  if (napi_get_typedarray_info(env, v, &t, len, data, &ab, &off) != napi_ok) return false;
  return t == want;
}
bool vec3Arg(napi_env env, napi_value v, double out[3]) {
  for (uint32_t k = 0; k < 3; k++) {
    napi_value e; if (napi_get_element(env, v, k, &e) != napi_ok) return false;
    if (napi_get_value_double(env, e, &out[k]) != napi_ok) return false;
  }
  return true;
}
bool gridArgs(napi_env env, napi_value* argv, Grid& G) {
  double n[3];
  if (!vec3Arg(env, argv[0], G.o) || !vec3Arg(env, argv[1], n) || napi_get_value_double(env, argv[2], &G.h) != napi_ok) return false;
  for (int k = 0; k < 3; k++) { if (!(n[k] >= 2 && n[k] < 1e5)) return false; G.n[k] = (int64_t)n[k]; }
  return G.h > 0 && (double)G.n[0] * G.n[1] * G.n[2] < 2e9;
}
template <class T>
napi_value makeTyped(napi_env env, napi_typedarray_type type, const T* src, size_t len) {
  void* data; napi_value ab, out;
  if (napi_create_arraybuffer(env, len * sizeof(T), &data, &ab) != napi_ok) return nullptr;
  if (len) std::memcpy(data, src, len * sizeof(T));
  if (napi_create_typedarray(env, type, len, ab, 0, &out) != napi_ok) return nullptr;
  return out;
}

napi_value Voxelize(napi_env env, napi_callback_info info) {
  size_t argc = 5; napi_value argv[5];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  float* pos; uint32_t* idx; size_t nP, nI; Grid G;
  if (argc < 5 || !typedArg(env, argv[0], napi_float32_array, (void**)&pos, &nP) || !typedArg(env, argv[1], napi_uint32_array, (void**)&idx, &nI) || !gridArgs(env, argv + 2, G)) {
    napi_throw_type_error(env, nullptr, "voxelize(pos: Float32Array, idx: Uint32Array, o, n, h)"); return nullptr;
  }
  const size_t nV = nP / 3, nF = nI / 3;
  for (size_t i = 0; i < nF * 3; i++) if (idx[i] >= nV) { napi_throw_range_error(env, nullptr, "voxelize: index out of range"); return nullptr; }
  const size_t voxels = (size_t)(G.n[0] * G.n[1] * G.n[2]);
  void* data; napi_value ab, out;
  CHECK(napi_create_arraybuffer(env, voxels, &data, &ab));
  uint8_t* votes = (uint8_t*)data;
  std::memset(votes, 0, voxels);
  // one vote array per axis so the three axes can run at the same time without sharing writes
  std::vector<uint8_t> vy(voxels, 0), vz(voxels, 0);
  uint8_t* axisVotes[3] = {votes, vy.data(), vz.data()};
  const unsigned T = hwThreads(), per = std::max(1u, T / 3);
  std::vector<std::thread> axes;
  for (int a = 0; a < 3; a++) axes.emplace_back([&, a]() { windingAlongAxis(pos, idx, nF, G, a, axisVotes[a], per); });
  for (auto& th : axes) th.join();
  parallelFor((voxels + 65535) / 65536, T, [&](size_t b) {
    const size_t s = b * 65536, e = std::min(voxels, s + 65536);
    for (size_t i = s; i < e; i++) votes[i] = (votes[i] + vy[i] + vz[i]) >= 2 ? 1 : 0;
  });
  CHECK(napi_create_typedarray(env, napi_uint8_array, voxels, ab, 0, &out));
  return out;
}

napi_value SurfaceNets(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  uint8_t* inside; size_t len; Grid G;
  if (argc < 4 || !typedArg(env, argv[0], napi_uint8_array, (void**)&inside, &len) || !gridArgs(env, argv + 1, G)) {
    napi_throw_type_error(env, nullptr, "surfaceNets(inside: Uint8Array, o, n, h)"); return nullptr;
  }
  if (len != (size_t)(G.n[0] * G.n[1] * G.n[2])) { napi_throw_range_error(env, nullptr, "surfaceNets: grid size mismatch"); return nullptr; }
  NetOut r; surfaceNets(inside, G, r);
  std::vector<float> P(r.P.begin(), r.P.end());
  napi_value obj, p, i, q;
  CHECK(napi_create_object(env, &obj));
  p = makeTyped(env, napi_float32_array, P.data(), P.size());
  i = makeTyped(env, napi_uint32_array, r.I.data(), r.I.size());
  q = makeTyped(env, napi_uint32_array, r.Q.data(), r.Q.size());
  if (!p || !i || !q) { napi_throw_error(env, nullptr, "surfaceNets: out of memory"); return nullptr; }
  CHECK(napi_set_named_property(env, obj, "pos", p));
  CHECK(napi_set_named_property(env, obj, "idx", i));
  CHECK(napi_set_named_property(env, obj, "quads", q));
  return obj;
}

napi_value FitSurface(napi_env env, napi_callback_info info) {
  size_t argc = 8; napi_value argv[8];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  float *P0, *sp; uint32_t *I, *si; uint8_t* buried = nullptr; size_t nP, nI, nSP, nSI, nB = 0;
  double maxSnap = 0, smoothD = 0; bool project = false;
  if (argc < 8 || !typedArg(env, argv[0], napi_float32_array, (void**)&P0, &nP) || !typedArg(env, argv[1], napi_uint32_array, (void**)&I, &nI)
      || !typedArg(env, argv[2], napi_float32_array, (void**)&sp, &nSP) || !typedArg(env, argv[3], napi_uint32_array, (void**)&si, &nSI)
      || napi_get_value_double(env, argv[5], &maxSnap) != napi_ok || napi_get_value_double(env, argv[6], &smoothD) != napi_ok
      || napi_get_value_bool(env, argv[7], &project) != napi_ok) {
    napi_throw_type_error(env, nullptr, "fitSurface(pos, idx, srcPos, srcIdx, buried|null, maxSnap, smooth, project)"); return nullptr;
  }
  napi_valuetype bt; napi_typeof(env, argv[4], &bt);
  if (bt != napi_null && bt != napi_undefined && !typedArg(env, argv[4], napi_uint8_array, (void**)&buried, &nB)) { napi_throw_type_error(env, nullptr, "fitSurface: buried must be a Uint8Array"); return nullptr; }
  const size_t nV = nP / 3, nSV = nSP / 3, nSF = nSI / 3;
  for (size_t i = 0; i < nI; i++) if (I[i] >= nV) { napi_throw_range_error(env, nullptr, "fitSurface: index out of range"); return nullptr; }
  for (size_t i = 0; i < nSF * 3; i++) if (si[i] >= nSV) { napi_throw_range_error(env, nullptr, "fitSurface: source index out of range"); return nullptr; }
  if (buried && nB < nSF) { napi_throw_range_error(env, nullptr, "fitSurface: buried is too short"); return nullptr; }
  const unsigned T = hwThreads();
  std::vector<float> P(P0, P0 + nP);
  TriTree tree(sp, si, nSF);

  // neighbours over triangle edges (deduplicated)
  std::vector<uint32_t> start(nV + 1, 0);
  for (size_t f = 0; f < nI; f += 3) for (int k = 0; k < 3; k++) start[I[f+k] + 1] += 2;
  for (size_t v = 0; v < nV; v++) start[v + 1] += start[v];
  std::vector<uint32_t> raw(start[nV]), fill(start.begin(), start.end() - 1);
  for (size_t f = 0; f < nI; f += 3) for (int k = 0; k < 3; k++) {
    const uint32_t a = I[f+k]; raw[fill[a]++] = I[f+(k+1)%3]; raw[fill[a]++] = I[f+(k+2)%3];
  }
  std::vector<uint32_t> nbS(nV + 1, 0), nb; nb.reserve(raw.size() / 2);
  { std::vector<int64_t> seen(nV, -1);
    for (size_t v = 0; v < nV; v++) { nbS[v] = (uint32_t)nb.size(); for (uint32_t j = start[v]; j < start[v + 1]; j++) { const uint32_t u = raw[j]; if (seen[u] != (int64_t)v) { seen[u] = v; nb.push_back(u); } } }
    nbS[nV] = (uint32_t)nb.size(); }

  const double max2 = maxSnap * maxSnap;
  auto snap = [&]() {
    parallelFor(nV, T, [&](size_t v) {
      V3 q{P[v*3], P[v*3+1], P[v*3+2]}, best; double bc[3];
      const int64_t f = tree.closest(q, max2, best, bc);
      if (f >= 0 && !(buried && buried[f])) { P[v*3] = (float)best.x; P[v*3+1] = (float)best.y; P[v*3+2] = (float)best.z; }
    });
  };
  auto relax = [&]() {
    std::vector<double> N(nP, 0.0);
    for (size_t f = 0; f < nI; f += 3) {
      const size_t a = I[f]*3, b = I[f+1]*3, c = I[f+2]*3;
      const double ux = P[b]-P[a], uy = P[b+1]-P[a+1], uz = P[b+2]-P[a+2], wx = P[c]-P[a], wy = P[c+1]-P[a+1], wz = P[c+2]-P[a+2];
      const double x = uy*wz - uz*wy, y = uz*wx - ux*wz, z = ux*wy - uy*wx;
      for (size_t t : {a, b, c}) { N[t] += x; N[t+1] += y; N[t+2] += z; }
    }
    std::vector<float> np(P);
    parallelFor(nV, T, [&](size_t v) {
      const uint32_t s0 = nbS[v], s1 = nbS[v + 1]; if (s1 == s0) return;
      double ax = 0, ay = 0, az = 0;
      for (uint32_t j = s0; j < s1; j++) { const size_t u = (size_t)nb[j] * 3; ax += P[u]; ay += P[u+1]; az += P[u+2]; }
      const double c = s1 - s0; const size_t i = v * 3;
      double dx = ax / c - P[i], dy = ay / c - P[i+1], dz = az / c - P[i+2];
      if (project) {
        double l = std::sqrt(N[i]*N[i] + N[i+1]*N[i+1] + N[i+2]*N[i+2]); if (!(l > 0)) l = 1;
        const double nx = N[i] / l, ny = N[i+1] / l, nz = N[i+2] / l, d = dx*nx + dy*ny + dz*nz;
        dx -= nx * d; dy -= ny * d; dz -= nz * d;
      }
      np[i] = (float)(P[i] + dx * 0.6); np[i+1] = (float)(P[i+1] + dy * 0.6); np[i+2] = (float)(P[i+2] + dz * 0.6);
    });
    P.swap(np);
  };
  const int smooth = (int)smoothD;
  if (project) snap();
  for (int it = 0; it < smooth; it++) { relax(); if (project) snap(); }

  // closest source face + barycentric weights for every vertex (no distance limit, buried faces allowed)
  std::vector<int32_t> face(nV, -1); std::vector<float> bary(nV * 3, 0.f);
  parallelFor(nV, T, [&](size_t v) {
    V3 q{P[v*3], P[v*3+1], P[v*3+2]}, best; double bc[3];
    const int64_t f = tree.closest(q, INFINITY, best, bc);
    face[v] = (int32_t)f; if (f >= 0) { bary[v*3] = (float)bc[0]; bary[v*3+1] = (float)bc[1]; bary[v*3+2] = (float)bc[2]; }
  });

  napi_value obj, po, fa, ba;
  CHECK(napi_create_object(env, &obj));
  po = makeTyped(env, napi_float32_array, P.data(), P.size());
  fa = makeTyped(env, napi_int32_array, face.data(), face.size());
  ba = makeTyped(env, napi_float32_array, bary.data(), bary.size());
  if (!po || !fa || !ba) { napi_throw_error(env, nullptr, "fitSurface: out of memory"); return nullptr; }
  CHECK(napi_set_named_property(env, obj, "pos", po));
  CHECK(napi_set_named_property(env, obj, "face", fa));
  CHECK(napi_set_named_property(env, obj, "bary", ba));
  return obj;
}

napi_value Info(napi_env env, napi_callback_info) {
  napi_value obj, v, t;
  CHECK(napi_create_object(env, &obj));
  CHECK(napi_create_string_utf8(env, kVersion, NAPI_AUTO_LENGTH, &v));
  CHECK(napi_create_uint32(env, hwThreads(), &t));
  CHECK(napi_set_named_property(env, obj, "version", v));
  CHECK(napi_set_named_property(env, obj, "threads", t));
  return obj;
}

}  // namespace

NAPI_MODULE_INIT() {
  napi_property_descriptor props[] = {
    {"voxelize", nullptr, Voxelize, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"surfaceNets", nullptr, SurfaceNets, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"fitSurface", nullptr, FitSurface, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"info", nullptr, Info, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
