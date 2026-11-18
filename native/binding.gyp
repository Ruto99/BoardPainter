{
  "targets": [
    {
      "target_name": "bp_native",
      "sources": ["bp_native.cc"],
      "defines": ["NAPI_VERSION=8", "NAPI_DISABLE_CPP_EXCEPTIONS"],
      "cflags_cc": ["-std=c++17", "-O3", "-pthread"],
      "ldflags": ["-pthread"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "GCC_OPTIMIZATION_LEVEL": "3",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      }
    }
  ]
}
