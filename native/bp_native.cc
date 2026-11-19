// BoardPainter native module (Node-API, so one build works across Electron versions).
// Heavy, self-contained mesh kernels ported from src/remesh.js, src/fieldretopo.js and src/bake.js. They produce the same results as the
// JavaScript versions (same arithmetic, same float32 rounding) but run in C++ on all CPU cores.
//
//   voxelize(pos: Float32Array, idx: Uint32Array, o: number[3], n: number[3], h: number) -> Uint8Array
//   surfaceNets(inside: Uint8Array, o: number[3], n: number[3], h: number) -> { pos, idx, quads }
//   fitSurface(pos, idx, srcPos, srcIdx, buried: Uint8Array|null, maxSnap, smooth, project) -> { pos, face, bary }
//   smoothOrient(N, Q, start, list, fq, iters, shuffle, parallel?) -> Float32Array            (fieldretopo.js)
//   smoothPos(V, N, Q, O, start, list, fo, fx, s, iters, shuffle, parallel?) -> Float32Array  (fieldretopo.js)
//   bake(lowPos, uvIdx, uv, highPos, highIdx, paint|null, size, maxDist, dilate) -> { normal, color, height, heightRange, hits, misses }  (bake.js)
//   mirrorPairs(pos, origin, cell, tol2) -> Int32Array  (computeMirror in index.html)
//   buildBVH(pos, idx) -> { index: Uint32Array (triangles reordered), nodes: Uint32Array }  three-mesh-bvh packed tree
//   info() -> { version, threads }
#define NAPI_VERSION 8
#include <node_api.h>

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <numeric>
#include <thread>
#include <vector>

namespace {

const char* kVersion = "1.4.0";

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

// ray / triangle, both sides: same test as three.js Ray.intersectTriangle (backfaceCulling = false)
inline V3 crossv(V3 a, V3 b) { return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x}; }
bool rayTri(V3 o, V3 d, V3 a, V3 b, V3 c, double& t) {
  V3 e1 = b - a, e2 = c - a, n = crossv(e1, e2);
  double DdN = dot(d, n), sign;
  if (DdN > 0) sign = 1; else if (DdN < 0) { sign = -1; DdN = -DdN; } else return false;
  V3 diff = o - a;
  const double DdQxE2 = sign * dot(d, crossv(diff, e2)); if (DdQxE2 < 0) return false;
  const double DdE1xQ = sign * dot(d, crossv(e1, diff)); if (DdE1xQ < 0) return false;
  if (DdQxE2 + DdE1xQ > DdN) return false;
  const double QdN = -sign * dot(diff, n); if (QdN < 0) return false;
  t = QdN / DdN; return true;
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
  // nearest ray hit with t >= 0 on either side of a triangle; returns face or -1
  int64_t raycast(V3 o, V3 d, double& tHit) const {
    if (nodes_.empty()) return -1;
    const double inv[3] = {1 / d.x, 1 / d.y, 1 / d.z}, oc[3] = {o.x, o.y, o.z};
    auto boxT = [&](const Node& n) -> double {
      double t0 = 0, t1 = INFINITY;
      for (int k = 0; k < 3; k++) {
        double a = (n.mn[k] - oc[k]) * inv[k], b = (n.mx[k] - oc[k]) * inv[k];
        if (std::isnan(a) || std::isnan(b)) { if (oc[k] < n.mn[k] || oc[k] > n.mx[k]) return INFINITY; continue; }
        if (a > b) std::swap(a, b);
        t0 = std::max(t0, a); t1 = std::min(t1, b);
        if (t0 > t1) return INFINITY;
      }
      return t0;
    };
    int64_t face = -1; double best = INFINITY;
    uint32_t stack[128]; int sp = 0; stack[sp++] = 0;
    while (sp) {
      const Node& n = nodes_[stack[--sp]];
      const double bt = boxT(n);
      if (bt == INFINITY || bt > best) continue;   // missed, or farther than the best hit so far
      if (n.count) {
        for (uint32_t t = n.start; t < n.start + n.count; t++) {
          const uint32_t f = tris_[t]; double th;
          if (rayTri(o, d, vtx(idx_[f*3]), vtx(idx_[f*3+1]), vtx(idx_[f*3+2]), th) && th < best) { best = th; face = f; }
        }
      } else {
        const uint32_t l = n.left, r = n.left + 1;
        const double tl = boxT(nodes_[l]), tr = boxT(nodes_[r]);
        if (sp + 2 > 128) continue;
        if (tl < tr) { stack[sp++] = r; stack[sp++] = l; } else { stack[sp++] = l; stack[sp++] = r; }
      }
    }
    tHit = best; return face;
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

// ---------------- field-aligned retopology: 4-RoSy orientation / position field smoothing ----------------
// The same Gauss-Seidel sweeps as smoothOrientations / smoothPositions in src/fieldretopo.js.
inline V3 normv(V3 v) { double l = std::hypot(v.x, v.y, v.z); if (!(l != 0)) l = 1; return {v.x / l, v.y / l, v.z / l}; }
inline V3 tangentOf(V3 v, V3 n) { const double d = dot(v, n); return {v.x - n.x*d, v.y - n.y*d, v.z - n.z*d}; }
inline V3 getf(const float* A, size_t i) { return {A[i*3], A[i*3+1], A[i*3+2]}; }
inline void setf(float* A, size_t i, V3 v) { A[i*3] = (float)v.x; A[i*3+1] = (float)v.y; A[i*3+2] = (float)v.z; }
inline double jsRound(double x) { return std::floor(x + 0.5); }   // Math.round

std::vector<uint32_t> visitOrder(size_t n, uint32_t seed) {   // order() in fieldretopo.js
  std::vector<uint32_t> o(n); for (size_t i = 0; i < n; i++) o[i] = (uint32_t)i;
  uint32_t r = seed ? seed : 1;
  for (size_t i = n; i-- > 1;) { r = r * 1664525u + 1013904223u; const size_t j = r % (i + 1); std::swap(o[i], o[j]); }
  return o;
}
void compatOrient(V3 q0, V3 n0, V3 q1, V3 n1, V3& ra, V3& rb) {
  const V3 A[2] = {q0, crossv(n0, q0)}, B[2] = {q1, crossv(n1, q1)};
  double best = -1, sgn = 1; int bi = 0, bj = 0;
  for (int i = 0; i < 2; i++) for (int j = 0; j < 2; j++) {
    const double d = dot(A[i], B[j]);
    if (std::fabs(d) > best) { best = std::fabs(d); bi = i; bj = j; sgn = d < 0 ? -1 : 1; }
  }
  ra = A[bi]; rb = {B[bj].x * sgn, B[bj].y * sgn, B[bj].z * sgn};
}
V3 lattice(V3 o, V3 q, V3 n, V3 p, double s, bool round) {
  const V3 t = crossv(n, q), d = p - o;
  const double a0 = dot(d, q) / s, b0 = dot(d, t) / s;
  const double a = round ? jsRound(a0) : std::floor(a0), b = round ? jsRound(b0) : std::floor(b0);
  return {o.x + (q.x*a + t.x*b)*s, o.y + (q.y*a + t.y*b)*s, o.z + (q.z*a + t.z*b)*s};
}
V3 middlePoint(V3 p0, V3 n0, V3 p1, V3 n1) {
  const double n0p0 = dot(n0, p0), n0p1 = dot(n0, p1), n1p0 = dot(n1, p0), n1p1 = dot(n1, p1);
  const double n0n1 = dot(n0, n1), den = 1 / (1 - n0n1*n0n1 + 1e-4);
  const double l0 = 2 * (n0p1 - n0p0 - n0n1 * (n1p0 - n1p1)) * den, l1 = 2 * (n1p0 - n1p1 - n0n1 * (n0p1 - n0p0)) * den;
  return {0.5*(p0.x+p1.x) - 0.25*(n0.x*l0 + n1.x*l1), 0.5*(p0.y+p1.y) - 0.25*(n0.y*l0 + n1.y*l1), 0.5*(p0.z+p1.z) - 0.25*(n0.z*l0 + n1.z*l1)};
}
void compatPos(V3 p0, V3 n0, V3 q0, V3 o0, V3 p1, V3 n1, V3 q1, V3 o1, double s, V3& r0, V3& r1) {
  const V3 t0 = crossv(n0, q0), t1 = crossv(n1, q1), m = middlePoint(p0, n0, p1, n1);
  const V3 a0 = lattice(o0, q0, n0, m, s, false), a1 = lattice(o1, q1, n1, m, s, false);
  V3 c1s[4];
  for (int j = 0; j < 4; j++) {
    const double j0 = j & 1, j1 = (j >> 1) & 1;
    c1s[j] = {a1.x + (j0*q1.x + j1*t1.x)*s, a1.y + (j0*q1.y + j1*t1.y)*s, a1.z + (j0*q1.z + j1*t1.z)*s};
  }
  double best = INFINITY;
  for (int i = 0; i < 4; i++) {
    const double i0 = i & 1, i1 = (i >> 1) & 1;
    const V3 c0{a0.x + (i0*q0.x + i1*t0.x)*s, a0.y + (i0*q0.y + i1*t0.y)*s, a0.z + (i0*q0.z + i1*t0.z)*s};
    for (int j = 0; j < 4; j++) {
      const V3 e = c0 - c1s[j]; const double d = e.x*e.x + e.y*e.y + e.z*e.z;
      if (d < best) { best = d; r0 = c0; r1 = c1s[j]; }
    }
  }
}
V3 onPlane(V3 o, V3 q, V3 t) {
  const V3 d = std::fabs(q.x) >= std::fabs(t.x) ? q : t;
  if (!(std::fabs(d.x) > 1e-3)) return o;
  return {o.x - d.x * o.x / d.x, o.y - d.y * o.x / d.x, o.z - d.z * o.x / d.x};
}
// Vertices are visited in the shuffled order. With `parallel`, they are first greedily coloured so that no two
// neighbours share a colour (as in Instant Meshes) and each colour class is updated on all cores. That changes
// the update order, so the result is not bit-identical to the JavaScript sweep, but it is still deterministic.
template <class F>
void sweep(size_t n, const uint32_t* st, const uint32_t* list, const std::vector<uint32_t>& ord, bool shuffle, bool parallel, int iters, F body) {
  if (!parallel || n < 4096) {
    for (int it = 0; it < iters; it++) for (size_t ii = 0; ii < n; ii++) body(shuffle ? ord[ii] : ii);
    return;
  }
  std::vector<int32_t> color(n, -1); std::vector<uint8_t> used; int nc = 0;
  for (size_t ii = 0; ii < n; ii++) {
    const size_t i = shuffle ? ord[ii] : ii;
    used.assign(nc + 1, 0);
    for (uint32_t j = st[i]; j < st[i + 1]; j++) { const int32_t c = color[list[j]]; if (c >= 0) used[c] = 1; }
    int c = 0; while (used[c]) c++;
    color[i] = c; nc = std::max(nc, c + 1);
  }
  std::vector<std::vector<uint32_t>> groups(nc);
  for (size_t ii = 0; ii < n; ii++) { const size_t i = shuffle ? ord[ii] : ii; groups[color[i]].push_back((uint32_t)i); }
  // one set of threads for all (iteration, colour) phases; a barrier separates the phases
  const unsigned T = std::max(1u, std::min<unsigned>(hwThreads(), (unsigned)(n / 1024)));
  const size_t phases = (size_t)iters * nc;
  std::vector<std::atomic<size_t>> next(phases);
  for (auto& a : next) a.store(0);
  std::mutex mu; std::condition_variable cv; unsigned arrived = 0; size_t generation = 0;
  auto barrier = [&]() {
    std::unique_lock<std::mutex> lk(mu);
    const size_t gen = generation;
    if (++arrived == T) { arrived = 0; generation++; cv.notify_all(); }
    else cv.wait(lk, [&] { return generation != gen; });
  };
  auto work = [&]() {
    for (size_t ph = 0; ph < phases; ph++) {
      const auto& g = groups[ph % nc];
      const size_t chunk = std::max<size_t>(16, g.size() / (T * 8));
      for (;;) {
        const size_t s = next[ph].fetch_add(chunk);
        if (s >= g.size()) break;
        for (size_t k = s, e = std::min(g.size(), s + chunk); k < e; k++) body(g[k]);
      }
      barrier();
    }
  };
  std::vector<std::thread> pool;
  for (unsigned t = 1; t < T; t++) pool.emplace_back(work);
  work();
  for (auto& th : pool) th.join();
}
void smoothOrient(size_t n, const float* N, float* Q, const uint32_t* st, const uint32_t* list, const uint8_t* fq, int iters, bool shuffle, bool parallel) {
  const std::vector<uint32_t> ord = shuffle ? visitOrder(n, 7) : std::vector<uint32_t>();
  sweep(n, st, list, ord, shuffle, parallel, iters, [&](size_t i) {
    if (fq[i]) return;
    const V3 ni = getf(N, i); V3 q = getf(Q, i); double ws = 0;
    for (uint32_t j = st[i]; j < st[i + 1]; j++) {
      const uint32_t u = list[j]; const double w = fq[u] ? 4 : 1;
      V3 a, b; compatOrient(q, ni, getf(Q, u), getf(N, u), a, b);
      q = normv(tangentOf({a.x*ws + b.x*w, a.y*ws + b.y*w, a.z*ws + b.z*w}, ni));
      ws += w;
    }
    setf(Q, i, q);
  });
}
void smoothPos(size_t n, const float* V, const float* N, const float* Q, float* O, const uint32_t* st, const uint32_t* list,
               const uint8_t* fo, const uint8_t* fx, double s, int iters, bool shuffle, bool parallel) {
  const std::vector<uint32_t> ord = shuffle ? visitOrder(n, 13) : std::vector<uint32_t>();
  sweep(n, st, list, ord, shuffle, parallel, iters, [&](size_t i) {
    if (fo[i]) return;
    const V3 vi = getf(V, i), ni = getf(N, i), qi = getf(Q, i);
    V3 o = getf(O, i); double ws = 0;
    for (uint32_t j = st[i]; j < st[i + 1]; j++) {
      const uint32_t u = list[j]; const double w = fo[u] ? 4 : 1;
      V3 a, b; compatPos(vi, ni, qi, o, getf(V, u), getf(N, u), getf(Q, u), getf(O, u), s, a, b);
      o = {(a.x*ws + b.x*w) / (ws + w), (a.y*ws + b.y*w) / (ws + w), (a.z*ws + b.z*w) / (ws + w)};
      ws += w;
      const double d = (o.x-vi.x)*ni.x + (o.y-vi.y)*ni.y + (o.z-vi.z)*ni.z;
      o = {o.x - ni.x*d, o.y - ni.y*d, o.z - ni.z*d};
    }
    o = lattice(o, qi, ni, vi, s, true);
    if (fx[i]) o = onPlane(o, qi, crossv(ni, qi));
    setf(O, i, o);
  });
}

// ---------------- texture baking (see bakeMaps in src/bake.js) ----------------
std::vector<float> vertexNormalsF(const float* p, size_t nP, const uint32_t* ix, size_t nI) {   // float32 sums, like the JS
  std::vector<float> n(nP, 0.f);
  for (size_t f = 0; f < nI; f += 3) {
    const size_t a = (size_t)ix[f]*3, b = (size_t)ix[f+1]*3, c = (size_t)ix[f+2]*3;
    const double ux = p[b]-p[a], uy = p[b+1]-p[a+1], uz = p[b+2]-p[a+2], wx = p[c]-p[a], wy = p[c+1]-p[a+1], wz = p[c+2]-p[a+2];
    const double x = uy*wz - uz*wy, y = uz*wx - ux*wz, z = ux*wy - uy*wx;
    for (size_t t : {a, b, c}) { n[t] = (float)(n[t] + x); n[t+1] = (float)(n[t+1] + y); n[t+2] = (float)(n[t+2] + z); }
  }
  for (size_t i = 0; i < nP; i += 3) {
    double l = std::hypot((double)n[i], (double)n[i+1], (double)n[i+2]); if (!(l != 0)) l = 1;
    n[i] = (float)(n[i] / l); n[i+1] = (float)(n[i+1] / l); n[i+2] = (float)(n[i+2] / l);
  }
  return n;
}
inline uint8_t clamp8(double v) { if (!(v > 0)) return 0; if (v >= 255) return 255; return (uint8_t)std::nearbyint(v); }   // Uint8ClampedArray
inline double lin2srgb(double x) { return x <= 0.0031308 ? 12.92 * x : 1.055 * std::pow(x, 1 / 2.4) - 0.055; }
void barycoord(V3 p, V3 a, V3 b, V3 c, double out[3]) {   // three.js Triangle.getBarycoord
  const V3 v0 = c - a, v1 = b - a, v2 = p - a;
  const double d00 = dot(v0, v0), d01 = dot(v0, v1), d02 = dot(v0, v2), d11 = dot(v1, v1), d12 = dot(v1, v2);
  const double den = d00 * d11 - d01 * d01;
  if (den == 0) { out[0] = 1; out[1] = out[2] = 0; return; }
  const double inv = 1 / den, u = (d11 * d02 - d01 * d12) * inv, v = (d00 * d12 - d01 * d02) * inv;
  out[0] = 1 - u - v; out[1] = v; out[2] = u;
}
struct BakeOut { std::vector<uint8_t> nrm, col, height; double range = 0; size_t hits = 0, misses = 0; };
void bake(const float* lp, size_t nLP, const uint32_t* li, size_t nLI, const float* uv, const float* hp, size_t nHP, const uint32_t* hi, size_t nHI,
          const float* paint, int S, double maxD, int dilate, BakeOut& out) {
  const size_t nF = nLI / 3, SS = (size_t)S * S;
  const unsigned T = hwThreads();
  const std::vector<float> ln = vertexNormalsF(lp, nLP, li, nLI), hn = vertexNormalsF(hp, nHP, hi, nHI);
  TriTree tree(hp, hi, nHI / 3);
  // 1. rasterise in UV space (in face order, first face wins, as in the JS) -> texel's face + weights
  std::vector<int32_t> tFace(SS, -1); std::vector<double> tW(SS * 2);
  std::vector<double> frame(nF * 6);
  for (size_t f = 0; f < nF; f++) {
    const uint32_t ia = li[f*3], ib = li[f*3+1], ic = li[f*3+2];
    const double u0 = uv[f*6] * S, v0 = uv[f*6+1] * S, u1 = uv[f*6+2] * S, v1 = uv[f*6+3] * S, u2 = uv[f*6+4] * S, v2 = uv[f*6+5] * S;
    const double det = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (std::fabs(det) < 1e-12) continue;
    const double e1x = lp[ib*3]-lp[ia*3], e1y = lp[ib*3+1]-lp[ia*3+1], e1z = lp[ib*3+2]-lp[ia*3+2];
    const double e2x = lp[ic*3]-lp[ia*3], e2y = lp[ic*3+1]-lp[ia*3+1], e2z = lp[ic*3+2]-lp[ia*3+2];
    const double du1 = (u1 - u0) / S, dv1 = (v1 - v0) / S, du2 = (u2 - u0) / S, dv2 = (v2 - v0) / S, r = 1 / (du1 * dv2 - du2 * dv1);
    double* F = &frame[f*6];
    F[0] = (e1x * dv2 - e2x * dv1) * r; F[1] = (e1y * dv2 - e2y * dv1) * r; F[2] = (e1z * dv2 - e2z * dv1) * r;
    F[3] = (e2x * du1 - e1x * du2) * r; F[4] = (e2y * du1 - e1y * du2) * r; F[5] = (e2z * du1 - e1z * du2) * r;
    const int x0 = (int)std::max(0.0, std::floor(std::min({u0, u1, u2}))), x1 = (int)std::min((double)S - 1, std::ceil(std::max({u0, u1, u2})));
    const int y0 = (int)std::max(0.0, std::floor(std::min({v0, v1, v2}))), y1 = (int)std::min((double)S - 1, std::ceil(std::max({v0, v1, v2})));
    const double eps = -0.5 / std::sqrt(std::fabs(det));
    for (int y = y0; y <= y1; y++) for (int x = x0; x <= x1; x++) {
      const double px = x + 0.5, py = y + 0.5;
      const double w1 = ((px - u0) * (v2 - v0) - (u2 - u0) * (py - v0)) / det, w2 = ((u1 - u0) * (py - v0) - (px - u0) * (v1 - v0)) / det, w0 = 1 - w1 - w2;
      if (w0 < eps || w1 < eps || w2 < eps) continue;
      const size_t k = (size_t)(S - 1 - y) * S + x;
      if (tFace[k] >= 0) continue;
      tFace[k] = (int32_t)f; tW[k*2] = w1; tW[k*2+1] = w2;
    }
  }
  // 2. per texel (in parallel): ray from outside along -normal, else the closest point
  out.nrm.assign(SS * 4, 0); if (paint) out.col.assign(SS * 4, 0);
  std::vector<uint8_t> filled(SS, 0); std::vector<float> hgt(SS, 0.f);
  std::atomic<size_t> hits{0}, misses{0};
  parallelFor((SS + 255) / 256, T, [&](size_t blk) {
    size_t h = 0, m = 0;
    for (size_t k = blk * 256, ke = std::min(SS, k + 256); k < ke; k++) {
      const int32_t f = tFace[k]; if (f < 0) continue;
      const uint32_t ia = li[f*3], ib = li[f*3+1], ic = li[f*3+2];
      const double w1 = tW[k*2], w2 = tW[k*2+1], w0 = 1 - w1 - w2;
      const V3 P{lp[ia*3]*w0 + lp[ib*3]*w1 + lp[ic*3]*w2, lp[ia*3+1]*w0 + lp[ib*3+1]*w1 + lp[ic*3+1]*w2, lp[ia*3+2]*w0 + lp[ib*3+2]*w1 + lp[ic*3+2]*w2};
      V3 N{ln[ia*3]*w0 + ln[ib*3]*w1 + ln[ic*3]*w2, ln[ia*3+1]*w0 + ln[ib*3+1]*w1 + ln[ic*3+1]*w2, ln[ia*3+2]*w0 + ln[ib*3+2]*w1 + ln[ic*3+2]*w2};
      { double l = std::sqrt(dot(N, N)); N = N * (1 / (l != 0 ? l : 1)); }
      const double* F = &frame[(size_t)f*6];
      V3 Tg{F[0], F[1], F[2]}; Tg = Tg + N * -dot(N, Tg);
      { double l = std::sqrt(dot(Tg, Tg)); Tg = Tg * (1 / (l != 0 ? l : 1)); }
      const V3 Bf{F[3], F[4], F[5]}, nt = crossv(N, Tg);
      const double handed = dot(Bf, nt) < 0 ? -1 : 1;
      const V3 B = nt * handed;
      const V3 O = P + N * maxD, D = N * -1;
      double t; int64_t face = tree.raycast(O, D, t); V3 point;
      if (face >= 0 && t <= 2 * maxD) point = O + D * t;
      else { double bc[3]; face = tree.closest(P, 4 * maxD * maxD, point, bc); if (face < 0) { m++; continue; } }
      h++;
      const uint32_t a = hi[face*3], b = hi[face*3+1], c = hi[face*3+2];
      double bc[3]; barycoord(point, getf(hp, a), getf(hp, b), getf(hp, c), bc);
      const double hx = hn[a*3]*bc[0] + hn[b*3]*bc[1] + hn[c*3]*bc[2], hy = hn[a*3+1]*bc[0] + hn[b*3+1]*bc[1] + hn[c*3+1]*bc[2], hz = hn[a*3+2]*bc[0] + hn[b*3+2]*bc[1] + hn[c*3+2]*bc[2];
      double hl = std::hypot(hx, hy, hz); if (!(hl != 0)) hl = 1;
      const V3 Hn{hx, hy, hz};
      out.nrm[k*4] = clamp8((dot(Hn, Tg) / hl * 0.5 + 0.5) * 255); out.nrm[k*4+1] = clamp8((dot(Hn, B) / hl * 0.5 + 0.5) * 255);
      out.nrm[k*4+2] = clamp8((dot(Hn, N) / hl * 0.5 + 0.5) * 255); out.nrm[k*4+3] = 255;
      if (paint) {
        for (int q = 0; q < 3; q++) out.col[k*4+q] = clamp8(lin2srgb(paint[a*3+q]*bc[0] + paint[b*3+q]*bc[1] + paint[c*3+q]*bc[2]) * 255);
        out.col[k*4+3] = 255;
      }
      hgt[k] = (float)((point.x - P.x) * N.x + (point.y - P.y) * N.y + (point.z - P.z) * N.z);
      filled[k] = 1;
    }
    hits += h; misses += m;
  });
  out.hits = hits; out.misses = misses;
  // 3. dilate chart borders (each pass reads the previous pass's result)
  for (int it = 0; it < dilate; it++) {
    std::vector<uint8_t> nf(filled);
    std::atomic<bool> any{false};
    parallelFor((size_t)S, T, [&](size_t y) {
      bool a = false;
      for (int x = 0; x < S; x++) {
        const size_t k = y * S + x; if (filled[k]) continue;
        int n = 0; double s0 = 0, s1 = 0, s2 = 0, c0 = 0, c1 = 0, c2 = 0, hh = 0;
        const int dx[4] = {1, -1, 0, 0}, dy[4] = {0, 0, 1, -1};
        for (int d = 0; d < 4; d++) {
          const int xx = x + dx[d], yy = (int)y + dy[d]; if (xx < 0 || yy < 0 || xx >= S || yy >= S) continue;
          const size_t q = (size_t)yy * S + xx; if (!filled[q]) continue;
          n++; s0 += out.nrm[q*4]; s1 += out.nrm[q*4+1]; s2 += out.nrm[q*4+2]; hh += hgt[q];
          if (paint) { c0 += out.col[q*4]; c1 += out.col[q*4+1]; c2 += out.col[q*4+2]; }
        }
        if (!n) continue;
        a = true; nf[k] = 2;
        // stash into the pixel itself: unfilled pixels are never read by this pass
        out.nrm[k*4] = clamp8(s0 / n); out.nrm[k*4+1] = clamp8(s1 / n); out.nrm[k*4+2] = clamp8(s2 / n); out.nrm[k*4+3] = 255;
        if (paint) { out.col[k*4] = clamp8(c0 / n); out.col[k*4+1] = clamp8(c1 / n); out.col[k*4+2] = clamp8(c2 / n); out.col[k*4+3] = 255; }
        hgt[k] = (float)(hh / n);
      }
      if (a) any = true;
    });
    if (!any) break;
    for (size_t k = 0; k < SS; k++) filled[k] = nf[k] ? 1 : 0;
  }
  for (size_t k = 0; k < SS; k++) if (!filled[k]) {
    out.nrm[k*4] = 128; out.nrm[k*4+1] = 128; out.nrm[k*4+2] = 255; out.nrm[k*4+3] = 255;
    if (paint) { out.col[k*4] = out.col[k*4+1] = out.col[k*4+2] = 128; out.col[k*4+3] = 255; }
  }
  double range = 0; for (size_t k = 0; k < SS; k++) if (filled[k]) range = std::max(range, (double)std::fabs(hgt[k]));
  out.range = range;
  out.height.assign(SS * 4, 255);
  for (size_t k = 0; k < SS; k++) { const uint8_t g = range > 0 && filled[k] ? clamp8(128 + hgt[k] / range * 127) : 128; out.height[k*4] = out.height[k*4+1] = out.height[k*4+2] = g; }
}

// ---------------- mirror pairs across x = 0 (see computeMirror in index.html) ----------------
// Grid hash of cell size `cell` from origin o; for every vertex the closest vertex to its mirror image within
// sqrt(tol2), searching the 27 surrounding cells. Cells are visited in the same order as the JavaScript and,
// inside a cell, vertices from the highest index down (its hash chains), so ties resolve the same way.
void mirrorPairs(const float* p, size_t n, const double o[3], double cell, double tol2, int32_t* out) {
  const unsigned T = hwThreads();
  const double M = 8192;
  auto keyOf = [&](double ix, double iy, double iz) { return (ix * M + iy) * M + iz; };
  std::vector<double> key(n);
  parallelFor(n, T, [&](size_t v) {
    key[v] = keyOf(std::floor((p[v*3] - o[0]) / cell), std::floor((p[v*3+1] - o[1]) / cell), std::floor((p[v*3+2] - o[2]) / cell));
  });
  std::vector<uint32_t> ord(n); std::iota(ord.begin(), ord.end(), 0u);
  std::sort(ord.begin(), ord.end(), [&](uint32_t a, uint32_t b) { return key[a] < key[b] || (key[a] == key[b] && a > b); });
  std::vector<double> sk(n); for (size_t i = 0; i < n; i++) sk[i] = key[ord[i]];
  parallelFor(n, T, [&](size_t v) {
    const double x = -(double)p[v*3], y = p[v*3+1], z = p[v*3+2];
    const double ix = std::floor((x - o[0]) / cell), iy = std::floor((y - o[1]) / cell), iz = std::floor((z - o[2]) / cell);
    int64_t best = -1; double bd = tol2;
    for (int a = -1; a <= 1; a++) for (int b = -1; b <= 1; b++) for (int c = -1; c <= 1; c++) {
      const double k = keyOf(ix + a, iy + b, iz + c);
      auto lo = std::lower_bound(sk.begin(), sk.end(), k);
      for (size_t i = lo - sk.begin(); i < n && sk[i] == k; i++) {
        const uint32_t u = ord[i];
        const double dx = p[u*3] - x, dy = p[u*3+1] - y, dz = p[u*3+2] - z, d2 = dx*dx + dy*dy + dz*dz;
        if (d2 <= bd) { bd = d2; best = u; }
      }
    }
    out[v] = (int32_t)best;
  });
}

// ---------------- BVH in three-mesh-bvh's packed layout (MeshBVH.deserialize) ----------------
// Node = 32 bytes, depth-first: 6 float32 bounds (min xyz, max xyz); a leaf has uint32 triangle offset at word 6,
// uint16 count at half-word 14 and 0xffff at half-word 15; an inner node has its right child's word index at word 6
// and the split axis at word 7 (the left child follows directly). Split: middle of the longest axis of the
// triangle-box centers (three-mesh-bvh's CENTER strategy), at most 10 triangles per leaf, depth 40.
struct TriB { float mn[3], mx[3]; uint32_t t; };
const size_t kLeafTris = 10;
const int kMaxDepth = 40;

void rangeBounds(const TriB* T, size_t o, size_t c, float b[6], float cb[6]) {
  for (int k = 0; k < 3; k++) { b[k] = cb[k] = INFINITY; b[k+3] = cb[k+3] = -INFINITY; }
  for (size_t i = o; i < o + c; i++) for (int k = 0; k < 3; k++) {
    const float lo = T[i].mn[k], hi = T[i].mx[k], ce = (lo + hi) * 0.5f;
    if (lo < b[k]) b[k] = lo; if (hi > b[k+3]) b[k+3] = hi;
    if (ce < cb[k]) cb[k] = ce; if (ce > cb[k+3]) cb[k+3] = ce;
  }
}
void putNode(std::vector<uint32_t>& out, const float b[6]) {
  const size_t at = out.size(); out.resize(at + 8, 0);
  std::memcpy(&out[at], b, 24);
}
void makeLeaf(std::vector<uint32_t>& out, size_t at, size_t o, size_t c) {
  out[at + 6] = (uint32_t)o;
  out[at + 7] = (uint32_t)c | (0xffffu << 16);   // half-words 14 (count) and 15 (leaf flag), little-endian
}
// partition [o, o+c) by the center split; returns the left count, or 0 / c when it doesn't split
size_t splitRange(TriB* T, size_t o, size_t c, const float cb[6], int& axisOut) {
  int axis = 0; float ext = cb[3] - cb[0];
  for (int k = 1; k < 3; k++) if (cb[k+3] - cb[k] > ext) { ext = cb[k+3] - cb[k]; axis = k; }
  axisOut = axis;
  if (!(ext > 0)) return 0;
  const float pos = (cb[axis] + cb[axis+3]) * 0.5f;
  size_t i = o, j = o + c;
  while (i < j) {
    if ((T[i].mn[axis] + T[i].mx[axis]) * 0.5f < pos) i++;
    else { j--; std::swap(T[i], T[j]); }
  }
  return i - o;
}
// depth-first build of [o, o+c) appended to `out` (word indices relative to out's start)
void buildSeq(TriB* T, size_t o, size_t c, int depth, std::vector<uint32_t>& out) {
  float b[6], cb[6]; rangeBounds(T, o, c, b, cb);
  const size_t at = out.size(); putNode(out, b);
  int axis = 0; size_t l = 0;
  if (c > kLeafTris && depth < kMaxDepth) l = splitRange(T, o, c, cb, axis);
  if ((l == 0 || l == c) && c > 0xffff) { l = c / 2; axis = 0; }   // a leaf can hold at most 65535 triangles
  if (l == 0 || l == c) { makeLeaf(out, at, o, c); return; }
  buildSeq(T, o, l, depth + 1, out);
  out[at + 6] = (uint32_t)out.size(); out[at + 7] = (uint32_t)axis;
  buildSeq(T, o + l, c - l, depth + 1, out);
}
// append a finished subtree block, moving its inner nodes' right pointers by `shift` words
void appendBlock(std::vector<uint32_t>& out, const std::vector<uint32_t>& blk, uint32_t shift) {
  const size_t base = out.size(); out.insert(out.end(), blk.begin(), blk.end());
  for (size_t n = base; n < out.size(); n += 8) if ((out[n + 7] >> 16) != 0xffffu) out[n + 6] += shift;
}
// the top of the tree splits into threads: both halves of a node are built at the same time
std::vector<uint32_t> buildPar(TriB* T, size_t o, size_t c, int depth, int spawn) {
  std::vector<uint32_t> out;
  if (spawn <= 0 || c < 200000) { out.reserve(c / 3 * 8 + 16); buildSeq(T, o, c, depth, out); return out; }
  float b[6], cb[6]; rangeBounds(T, o, c, b, cb);
  putNode(out, b);
  int axis = 0; size_t l = splitRange(T, o, c, cb, axis);
  if (l == 0 || l == c) { if (c > 0xffff) { l = c / 2; axis = 0; } else { makeLeaf(out, 0, o, c); return out; } }
  std::vector<uint32_t> L, R;
  std::thread th([&] { L = buildPar(T, o, l, depth + 1, spawn - 1); });
  R = buildPar(T, o + l, c - l, depth + 1, spawn - 1);
  th.join();
  appendBlock(out, L, 8);
  out[6] = (uint32_t)out.size(); out[7] = (uint32_t)axis;
  appendBlock(out, R, (uint32_t)out.size());
  return out;
}
void buildBVH(const float* p, const uint32_t* ix, size_t nF, std::vector<uint32_t>& outIdx, std::vector<uint32_t>& nodes) {
  const unsigned TH = hwThreads();
  std::vector<TriB> T(nF);
  parallelFor(nF, TH, [&](size_t f) {
    TriB& t = T[f]; t.t = (uint32_t)f;
    for (int k = 0; k < 3; k++) {
      const float a = p[ix[f*3]*3+k], b = p[ix[f*3+1]*3+k], c = p[ix[f*3+2]*3+k];
      t.mn[k] = std::min(a, std::min(b, c)); t.mx[k] = std::max(a, std::max(b, c));
    }
  });
  int spawn = 0; while ((1u << spawn) < TH * 2 && spawn < 8) spawn++;
  nodes = buildPar(T.data(), 0, nF, 0, spawn);
  outIdx.resize(nF * 3);
  parallelFor(nF, TH, [&](size_t i) { const uint32_t f = T[i].t; outIdx[i*3] = ix[f*3]; outIdx[i*3+1] = ix[f*3+1]; outIdx[i*3+2] = ix[f*3+2]; });
}

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

// adjacency (CSR) must stay inside n vertices
bool checkAdj(const uint32_t* st, size_t nSt, const uint32_t* list, size_t nList, size_t n) {
  if (nSt != n + 1 || st[0] != 0 || st[n] > nList) return false;
  for (size_t i = 0; i < n; i++) if (st[i + 1] < st[i]) return false;
  for (size_t j = 0; j < st[n]; j++) if (list[j] >= n) return false;
  return true;
}

// smoothOrient(N, Q, start, list, fq, iters, shuffle, parallel?) -> Float32Array (smoothed Q)
napi_value SmoothOrient(napi_env env, napi_callback_info info) {
  size_t argc = 8; napi_value argv[8];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  float *N, *Q0; uint32_t *st, *list; uint8_t* fq; size_t nN, nQ, nSt, nL, nFq; double iters = 0; bool shuffle = false;
  if (argc < 7 || !typedArg(env, argv[0], napi_float32_array, (void**)&N, &nN) || !typedArg(env, argv[1], napi_float32_array, (void**)&Q0, &nQ)
      || !typedArg(env, argv[2], napi_uint32_array, (void**)&st, &nSt) || !typedArg(env, argv[3], napi_uint32_array, (void**)&list, &nL)
      || !typedArg(env, argv[4], napi_uint8_array, (void**)&fq, &nFq) || napi_get_value_double(env, argv[5], &iters) != napi_ok
      || napi_get_value_bool(env, argv[6], &shuffle) != napi_ok) {
    napi_throw_type_error(env, nullptr, "smoothOrient(N, Q, start, list, fq, iters, shuffle)"); return nullptr;
  }
  const size_t n = nQ / 3;
  if (nN != nQ || nQ % 3 || nFq < n || !checkAdj(st, nSt, list, nL, n)) { napi_throw_range_error(env, nullptr, "smoothOrient: inconsistent sizes"); return nullptr; }
  std::vector<float> Q(Q0, Q0 + nQ);
  bool parallel = false; if (argc > 7) napi_get_value_bool(env, argv[7], &parallel);
  smoothOrient(n, N, Q.data(), st, list, fq, (int)std::min(1000.0, std::max(0.0, iters)), shuffle, parallel);
  napi_value r = makeTyped(env, napi_float32_array, Q.data(), Q.size());
  if (!r) { napi_throw_error(env, nullptr, "smoothOrient: out of memory"); return nullptr; }
  return r;
}

// smoothPos(V, N, Q, O, start, list, fo, fx, s, iters, shuffle, parallel?) -> Float32Array (smoothed O)
napi_value SmoothPos(napi_env env, napi_callback_info info) {
  size_t argc = 12; napi_value argv[12];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  float *V, *N, *Q, *O0; uint32_t *st, *list; uint8_t *fo, *fx; size_t nV, nN, nQ, nO, nSt, nL, nFo, nFx; double s = 0, iters = 0; bool shuffle = false;
  if (argc < 11 || !typedArg(env, argv[0], napi_float32_array, (void**)&V, &nV) || !typedArg(env, argv[1], napi_float32_array, (void**)&N, &nN)
      || !typedArg(env, argv[2], napi_float32_array, (void**)&Q, &nQ) || !typedArg(env, argv[3], napi_float32_array, (void**)&O0, &nO)
      || !typedArg(env, argv[4], napi_uint32_array, (void**)&st, &nSt) || !typedArg(env, argv[5], napi_uint32_array, (void**)&list, &nL)
      || !typedArg(env, argv[6], napi_uint8_array, (void**)&fo, &nFo) || !typedArg(env, argv[7], napi_uint8_array, (void**)&fx, &nFx)
      || napi_get_value_double(env, argv[8], &s) != napi_ok || napi_get_value_double(env, argv[9], &iters) != napi_ok
      || napi_get_value_bool(env, argv[10], &shuffle) != napi_ok) {
    napi_throw_type_error(env, nullptr, "smoothPos(V, N, Q, O, start, list, fo, fx, s, iters, shuffle)"); return nullptr;
  }
  const size_t n = nO / 3;
  if (nV != nO || nN != nO || nQ != nO || nO % 3 || nFo < n || nFx < n || !(s > 0) || !checkAdj(st, nSt, list, nL, n)) {
    napi_throw_range_error(env, nullptr, "smoothPos: inconsistent sizes"); return nullptr;
  }
  std::vector<float> O(O0, O0 + nO);
  bool parallel = false; if (argc > 11) napi_get_value_bool(env, argv[11], &parallel);
  smoothPos(n, V, N, Q, O.data(), st, list, fo, fx, s, (int)std::min(1000.0, std::max(0.0, iters)), shuffle, parallel);
  napi_value r = makeTyped(env, napi_float32_array, O.data(), O.size());
  if (!r) { napi_throw_error(env, nullptr, "smoothPos: out of memory"); return nullptr; }
  return r;
}

// bake(lowPos, uvIdx, uv, highPos, highIdx, paint|null, size, maxDist, dilate) -> { normal, color|null, height, heightRange, hits, misses }
napi_value Bake(napi_env env, napi_callback_info info) {
  size_t argc = 9; napi_value argv[9];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  float *lp, *uv, *hp, *paint = nullptr; uint32_t *li, *hi; size_t nLP, nLI, nUV, nHP, nHI, nPaint = 0; double size = 0, maxD = 0, dilate = 0;
  if (argc < 9 || !typedArg(env, argv[0], napi_float32_array, (void**)&lp, &nLP) || !typedArg(env, argv[1], napi_uint32_array, (void**)&li, &nLI)
      || !typedArg(env, argv[2], napi_float32_array, (void**)&uv, &nUV) || !typedArg(env, argv[3], napi_float32_array, (void**)&hp, &nHP)
      || !typedArg(env, argv[4], napi_uint32_array, (void**)&hi, &nHI) || napi_get_value_double(env, argv[6], &size) != napi_ok
      || napi_get_value_double(env, argv[7], &maxD) != napi_ok || napi_get_value_double(env, argv[8], &dilate) != napi_ok) {
    napi_throw_type_error(env, nullptr, "bake(lowPos, uvIdx, uv, highPos, highIdx, paint|null, size, maxDist, dilate)"); return nullptr;
  }
  napi_valuetype pt; napi_typeof(env, argv[5], &pt);
  if (pt != napi_null && pt != napi_undefined && !typedArg(env, argv[5], napi_float32_array, (void**)&paint, &nPaint)) { napi_throw_type_error(env, nullptr, "bake: paint must be a Float32Array"); return nullptr; }
  const size_t nLV = nLP / 3, nHV = nHP / 3, nF = nLI / 3;
  if (nLI % 3 || nHI % 3 || nUV < nF * 6 || (paint && nPaint < nHV * 3) || !(size >= 1 && size <= 16384) || !(maxD > 0)) { napi_throw_range_error(env, nullptr, "bake: inconsistent sizes"); return nullptr; }
  for (size_t i = 0; i < nLI; i++) if (li[i] >= nLV) { napi_throw_range_error(env, nullptr, "bake: low index out of range"); return nullptr; }
  for (size_t i = 0; i < nHI; i++) if (hi[i] >= nHV) { napi_throw_range_error(env, nullptr, "bake: high index out of range"); return nullptr; }
  BakeOut o;
  bake(lp, nLP, li, nLI, uv, hp, nHP, hi, nHI, paint, (int)size, maxD, (int)std::min(64.0, std::max(0.0, dilate)), o);
  napi_value obj, nv, cv, hv, rv, hitv, missv;
  CHECK(napi_create_object(env, &obj));
  nv = makeTyped(env, napi_uint8_clamped_array, o.nrm.data(), o.nrm.size());
  hv = makeTyped(env, napi_uint8_clamped_array, o.height.data(), o.height.size());
  if (paint) cv = makeTyped(env, napi_uint8_clamped_array, o.col.data(), o.col.size()); else CHECK(napi_get_null(env, &cv));
  if (!nv || !hv || !cv) { napi_throw_error(env, nullptr, "bake: out of memory"); return nullptr; }
  CHECK(napi_create_double(env, o.range, &rv)); CHECK(napi_create_double(env, (double)o.hits, &hitv)); CHECK(napi_create_double(env, (double)o.misses, &missv));
  CHECK(napi_set_named_property(env, obj, "normal", nv)); CHECK(napi_set_named_property(env, obj, "color", cv));
  CHECK(napi_set_named_property(env, obj, "height", hv)); CHECK(napi_set_named_property(env, obj, "heightRange", rv));
  CHECK(napi_set_named_property(env, obj, "hits", hitv)); CHECK(napi_set_named_property(env, obj, "misses", missv));
  return obj;
}

// mirrorPairs(pos: Float32Array, origin: number[3], cell, tol2) -> Int32Array (mirror vertex or -1)
napi_value MirrorPairs(napi_env env, napi_callback_info info) {
  size_t argc = 4; napi_value argv[4];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  float* p; size_t nP; double o[3], cell = 0, tol2 = 0;
  if (argc < 4 || !typedArg(env, argv[0], napi_float32_array, (void**)&p, &nP) || !vec3Arg(env, argv[1], o)
      || napi_get_value_double(env, argv[2], &cell) != napi_ok || napi_get_value_double(env, argv[3], &tol2) != napi_ok) {
    napi_throw_type_error(env, nullptr, "mirrorPairs(pos, origin, cell, tol2)"); return nullptr;
  }
  if (nP % 3 || !(cell > 0) || !(tol2 >= 0) || nP / 3 > 0x7fffffff) { napi_throw_range_error(env, nullptr, "mirrorPairs: bad arguments"); return nullptr; }
  const size_t n = nP / 3;
  std::vector<int32_t> out(n, -1);
  mirrorPairs(p, n, o, cell, tol2, out.data());
  napi_value r = makeTyped(env, napi_int32_array, out.data(), out.size());
  if (!r) { napi_throw_error(env, nullptr, "mirrorPairs: out of memory"); return nullptr; }
  return r;
}

// buildBVH(pos: Float32Array, idx: Uint32Array) -> { index: Uint32Array, nodes: Uint32Array }
napi_value BuildBVH(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value argv[2];
  CHECK(napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr));
  float* p; uint32_t* ix; size_t nP, nI;
  if (argc < 2 || !typedArg(env, argv[0], napi_float32_array, (void**)&p, &nP) || !typedArg(env, argv[1], napi_uint32_array, (void**)&ix, &nI)) {
    napi_throw_type_error(env, nullptr, "buildBVH(pos: Float32Array, idx: Uint32Array)"); return nullptr;
  }
  const size_t nV = nP / 3, nF = nI / 3;
  if (nP % 3 || nI % 3 || !nF || nF > 0x7fffffff) { napi_throw_range_error(env, nullptr, "buildBVH: bad sizes"); return nullptr; }
  for (size_t i = 0; i < nI; i++) if (ix[i] >= nV) { napi_throw_range_error(env, nullptr, "buildBVH: index out of range"); return nullptr; }
  std::vector<uint32_t> outIdx, nodes;
  buildBVH(p, ix, nF, outIdx, nodes);
  if ((double)nodes.size() > 4294967295.0) { napi_throw_range_error(env, nullptr, "buildBVH: tree too large"); return nullptr; }
  napi_value obj, iv, nv;
  CHECK(napi_create_object(env, &obj));
  iv = makeTyped(env, napi_uint32_array, outIdx.data(), outIdx.size());
  nv = makeTyped(env, napi_uint32_array, nodes.data(), nodes.size());
  if (!iv || !nv) { napi_throw_error(env, nullptr, "buildBVH: out of memory"); return nullptr; }
  CHECK(napi_set_named_property(env, obj, "index", iv)); CHECK(napi_set_named_property(env, obj, "nodes", nv));
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
    {"smoothOrient", nullptr, SmoothOrient, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"smoothPos", nullptr, SmoothPos, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"bake", nullptr, Bake, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"mirrorPairs", nullptr, MirrorPairs, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"buildBVH", nullptr, BuildBVH, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"info", nullptr, Info, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, sizeof(props) / sizeof(props[0]), props);
  return exports;
}
