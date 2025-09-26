## Sync in AWS
aws s3 sync "C:\Users\sourav\Desktop\Website_data\data\Project_5_ES_Control" s3://iowadot/Project_5_ES_Control/ --endpoint-url https://be483456e1e831e0e5b9938ce7f07fe4.r2.cloudflarestorage.com --profile r2
## copy in AWS
aws s3 cp 09232025_M3M_RGB.tif s3://iowadot/09232025_M3M_RGB.tif --endpoint-url https://be483456e1e831e0e5b9938ce7f07fe4.r2.cloudflarestorage.com --profile r2
##lists buckets
aws s3api list-buckets --endpoint-url https://be483456e1e831e0e5b9938ce7f07fe4.r2.cloudflarestorage.com --profile r2


# gdals

gdal2tiles.py -z 15-26 -w leaflet --processes=28 /mnt/c/Users/sourav/Documents/Web_Mapping/Media/Mediapolis_Astro_200_Hillshade.tif /mnt/c/Users/sourav/Documents/Web_Mapping/Mediapolis_Astro_200_Hillshade





account_id = "be483456e1e831e0e5b9938ce7f07fe4" 
access_key = "d4604d056eaca24772ddbac026e18c5c"   # from Cloudflare R2 dashboard
secret_key = "c331fe402e99e12a6db7a22c37f7af8690fcef6d1dbb5603f7640292c64b74a6"   # from Cloudflare R2 dashboard
bucket_name = "iowadot"
