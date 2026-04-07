openapi: 3.0.0
info:
  title: ${api_name}
  version: 1.0.0

paths:
  # Angular browser bundle assets from Object Storage
  /browser/{proxy+}:
    get:
      summary: Serve Angular browser assets
      parameters:
        - name: proxy
          in: path
          required: true
          schema:
            type: string
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${assets_bucket}
        object: browser/{proxy}
        service_account_id: ${service_account_id}

  /assets/{proxy+}:
    get:
      summary: Serve Angular static assets
      parameters:
        - name: proxy
          in: path
          required: true
          schema:
            type: string
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${assets_bucket}
        object: browser/assets/{proxy}
        service_account_id: ${service_account_id}

  /favicon.ico:
    get:
      summary: Serve favicon
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${assets_bucket}
        object: browser/favicon.ico
        service_account_id: ${service_account_id}

  /robots.txt:
    get:
      summary: Serve robots.txt
      x-yc-apigateway-integration:
        type: object_storage
        bucket: ${assets_bucket}
        object: browser/robots.txt
        service_account_id: ${service_account_id}

%{ if has_image ~}
  # Image optimization endpoint
  /_image:
    get:
      summary: Angular image optimization
      parameters:
        - name: url
          in: query
          required: true
          schema:
            type: string
        - name: w
          in: query
          required: false
          schema:
            type: integer
        - name: q
          in: query
          required: false
          schema:
            type: integer
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${image_function_id}
        service_account_id: ${service_account_id}
        payload_format_version: "2.0"
%{ endif ~}

%{ if has_server ~}
  # Express API routes
  /api/{proxy+}:
    x-yc-apigateway-any-method:
      summary: API route handler
      parameters:
        - name: proxy
          in: path
          required: false
          schema:
            type: string
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${server_function_id}
        service_account_id: ${service_account_id}
        payload_format_version: "2.0"

  # Catch-all for Angular SSR
  /{proxy+}:
    x-yc-apigateway-any-method:
      summary: Server-side rendered pages
      parameters:
        - name: proxy
          in: path
          required: false
          schema:
            type: string
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${server_function_id}
        service_account_id: ${service_account_id}
        payload_format_version: "2.0"

  # Root path
  /:
    x-yc-apigateway-any-method:
      summary: Root path handler
      x-yc-apigateway-integration:
        type: cloud_functions
        function_id: ${server_function_id}
        service_account_id: ${service_account_id}
        payload_format_version: "2.0"
%{ endif ~}
