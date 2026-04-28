self.__BUILD_MANIFEST = {
  "__rewrites": {
    "afterFiles": [
      {
        "source": "/api/harness/:path*"
      },
      {
        "source": "/api/plugins/:path*"
      },
      {
        "source": "/api/admin-sidebar/:path*"
      },
      {
        "source": "/api/repo-git/:path*"
      },
      {
        "source": "/api/build-info"
      }
    ],
    "beforeFiles": [],
    "fallback": []
  },
  "sortedPages": [
    "/_app",
    "/_error"
  ]
};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()